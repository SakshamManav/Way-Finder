import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

import dotenv from "dotenv";
import express from "express";
import cors from "cors";

import { connectDb, collections, ObjectId } from "./db.js";
import { connectRedis } from "./redis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, "../../worker");

// API-side audit log (submissions, dedupes, re-runs, page views). The worker
// writes its own detailed pipeline log to worker/logs/job-<id>.log.
const API_LOG_DIR = path.resolve(__dirname, "../logs");
fs.mkdirSync(API_LOG_DIR, { recursive: true });
const apiLog = fs.createWriteStream(path.join(API_LOG_DIR, "api.log"), {
  flags: "a",
});
function alog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  apiLog.write(line + "\n");
}

// Project-root .env holds OPENROUTER_API_KEY / ENABLE_AI_RANKING etc.; spawned
// workers inherit the loaded vars. Real env always wins over the file.
dotenv.config({ path: path.resolve(__dirname, "../..", ".env") });

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) throw new Error("repoUrl is required");
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  const m = u.match(/github\.com[:/]([^/\s:]+)\/([^/\s:]+)/)
    || u.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) throw new Error("Provide a GitHub repo URL like https://github.com/owner/repo or owner/repo");
  return `https://github.com/${m[1]}/${m[2]}`;
}

function spawnWorker(jobId, url) {
  const workerEntry = path.join(WORKER_DIR, "analyzer.py");
  const py = process.env.PYTHON_BIN || "python";
  const logDir = path.join(WORKER_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `job-${jobId}.log`), "a");
  const child = spawn(py, [workerEntry, String(jobId), url], {
    cwd: WORKER_DIR,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child;
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

async function purgeRepoData(repoId) {
  const cols = collections();
  await Promise.all([
    cols.commit_samples.deleteMany({ repo_id: repoId }),
    cols.file_metrics.deleteMany({ repo_id: repoId }),
    cols.flagged_spikes.deleteMany({ repo_id: repoId }),
    cols.ownership_decay.deleteMany({ repo_id: repoId }),
    cols.onboarding_path.deleteMany({ repo_id: repoId }),
  ]);
}

// ---------------------------------------------------------------------------
// POST /api/analyze        { repoUrl } -> { jobId, cached }
// ---------------------------------------------------------------------------
app.post("/api/analyze", async (req, res) => {
  try {
    const url = normalizeUrl(req.body?.repoUrl);
    const force = req.body?.force === true;
    alog(`analyze requested  url=${url}  force=${force}`);
    const cols = collections();
    let repo = await cols.repos.findOne({ url });

    if (repo && !force && (repo.status === "queued" || repo.status === "running")) {
      alog(`  dedupe: already queued/running  jobId=${repo._id}  status=${repo.status}`);
      return res.json({ jobId: repo._id.toString(), cached: false });
    }
    if (repo && !force && repo.status === "done") {
      alog(`  dedupe: already analyzed  jobId=${repo._id}  (cached report served)`);
      return res.json({ jobId: repo._id.toString(), cached: true });
    }
    if (repo && repo.status === "failed") {
      await purgeRepoData(repo._id);
      await cols.repos.deleteOne({ _id: repo._id });
      alog(`  cleaned failed attempt  jobId=${repo._id}`);
    } else if (repo && force) {
      await purgeRepoData(repo._id);
      await cols.repos.deleteOne({ _id: repo._id });
      alog(`  force re-analyze: purged previous run  jobId=${repo._id}`);
    }

    const insert = await cols.repos.insertOne({
      url,
      status: "queued",
      created_at: new Date(),
    });
    spawnWorker(insert.insertedId, url);
    alog(`  queued  jobId=${insert.insertedId}  worker spawned`);
    res.json({ jobId: insert.insertedId.toString(), cached: false });
  } catch (e) {
    alog(`  ERROR ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analyze/:jobId/status
// ---------------------------------------------------------------------------
app.get("/api/analyze/:jobId/status", async (req, res) => {
  try {
    const { jobId } = req.params;
    const repo = await collections().repos.findOne({ _id: new ObjectId(jobId) });
    if (!repo) return res.status(404).json({ error: "unknown job" });

    let progress = null;
    try {
      const redis = await connectRedis();
      const raw = await redis.get(`job:${jobId}:progress`);
      if (raw) progress = JSON.parse(raw);
    } catch (e) { /* Redis is optional for status */ }

    res.json({
      jobId,
      repoId: repo._id.toString(),
      url: repo.url,
      status: repo.status,
      progress,
      total_commits: repo.total_commits ?? null,
      sampled_commit_count: repo.sampled_commit_count ?? null,
      default_branch: repo.default_branch ?? null,
      error_message: repo.error_message ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/repos/:repoId/report
// ---------------------------------------------------------------------------
app.get("/api/repos/:repoId/report", async (req, res) => {
  try {
    const repoId = new ObjectId(req.params.repoId);
    const cols = collections();
    const repo = await cols.repos.findOne({ _id: repoId });
    if (!repo) return res.status(404).json({ error: "unknown repo" });
    if (repo.status !== "done") {
      return res.status(202).json({ status: repo.status, jobId: repoId.toString() });
    }
    alog(`report served  repoId=${repoId}  url=${repo.url}`);

    const [spikes, decay, onboarding, samples] = await Promise.all([
      cols.flagged_spikes.find({ repo_id: repoId }).sort({ delta: -1 }).toArray(),
      cols.ownership_decay.find({ repo_id: repoId }).toArray(),
      cols.onboarding_path.findOne({ repo_id: repoId }),
      cols.commit_samples.find({ repo_id: repoId }).sort({ commit_date: 1 }).toArray(),
    ]);

    const riskOrder = { high: 0, medium: 1, low: 2 };
    const sortDecay = (a, b) =>
      (riskOrder[a.risk_level] - riskOrder[b.risk_level])
      || (b.inactive_duration_days - a.inactive_duration_days);

    const decayActive = decay.filter((d) => d.still_exists).sort(sortDecay);
    const decayHistorical = decay.filter((d) => !d.still_exists).sort(sortDecay);

    res.json({
      repo: {
        id: repo._id.toString(),
        url: repo.url,
        default_branch: repo.default_branch,
        total_commits: repo.total_commits,
        sampled_commit_count: repo.sampled_commit_count,
        last_analyzed_at: iso(repo.last_analyzed_at),
      },
      sampling: {
        message:
          `Analyzed ${repo.sampled_commit_count} commits sampled across ` +
          `${repo.total_commits} total for performance, including the first and last commit.`,
      },
      spikes: spikes.slice(0, 20).map((s) => ({
        id: s._id.toString(),
        metric: s.metric,
        delta: s.delta,
        gap_commits: s.gap_commits,
        commit_range: s.commit_sha_range,
        affected_files: s.affected_files,
        reason: s.human_readable_reason,
      })),
      decay: {
        active: decayActive.slice(0, 30).map((d) => ({
          path: d.path,
          former_primary_owner: d.former_primary_owner,
          owner_commit_share: d.owner_commit_share,
          inactive_duration_days: d.inactive_duration_days,
          risk_level: d.risk_level,
          last_active_commit_date: iso(d.last_active_commit_date),
        })),
        historical: decayHistorical.slice(0, 30).map((d) => ({
          path: d.path,
          former_primary_owner: d.former_primary_owner,
          owner_commit_share: d.owner_commit_share,
          inactive_duration_days: d.inactive_duration_days,
          risk_level: d.risk_level,
          last_active_commit_date: iso(d.last_active_commit_date),
        })),
      },
      onboarding: onboarding
        ? {
            ordered_files: onboarding.ordered_files,
            generated_from_commit: onboarding.generated_from_commit,
            ai_ranking: onboarding.ai_ranking ?? null,
          }
        : { ordered_files: [] },
      series: samples.map((s) => ({
        commit_sha: s.commit_sha,
        commit_date: iso(s.commit_date),
        avg_complexity: s.avg_complexity,
        total_complexity: s.total_complexity,
        total_edges: s.total_edges,
        total_files: s.total_files,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/repos/:repoId/graph?commitSha=...
// ---------------------------------------------------------------------------
app.get("/api/repos/:repoId/graph", async (req, res) => {
  try {
    const repoId = new ObjectId(req.params.repoId);
    const cols = collections();
    const query = { repo_id: repoId };
    if (req.query.commitSha) query.commit_sha = String(req.query.commitSha);

    // With a commitSha: exact match; otherwise default to the final sampled commit.
    let doc = req.query.commitSha
      ? await cols.commit_samples.findOne(query)
      : await cols.commit_samples.find({ repo_id: repoId })
          .sort({ commit_date: -1 }).limit(1).next();
    if (!doc) {
      doc = await cols.commit_samples.find({ repo_id: repoId })
        .sort({ commit_date: -1 }).limit(1).next();
    }
    if (!doc) return res.status(404).json({ error: "no graph data" });

    const nodePaths = new Set();
    const edges = [];
    const byPath = new Map();
    for (const f of doc.files) {
      nodePaths.add(f.path);
      byPath.set(f.path, f);
      for (const target of f.imports) {
        if (target !== f.path) edges.push({ source: f.path, target });
      }
    }

    // Keep the graph renderable: cap nodes to the highest-degree files.
    const MAX_NODES = 800;
    let nodeList = [...nodePaths];
    if (nodeList.length > MAX_NODES) {
      const degree = new Map(nodePaths.size);
      for (const n of nodePaths) degree.set(n, 0);
      for (const e of edges) {
        degree.set(e.source, (degree.get(e.source) || 0) + 1);
        degree.set(e.target, (degree.get(e.target) || 0) + 1);
      }
      nodeList = nodeList
        .sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0))
        .slice(0, MAX_NODES);
      const keep = new Set(nodeList);
      edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    }

    res.json({
      commit_sha: doc.commit_sha,
      commit_date: iso(doc.commit_date),
      nodes: nodeList.map((p) => {
        const f = byPath.get(p) || {};
        return {
          id: p,
          path: p,
          complexity_score: f.complexity_score ?? 0,
          loc: f.loc ?? 0,
          import_count: f.import_count ?? 0,
          function_count: f.function_count ?? 0,
        };
      }),
      edges,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4000;

async function main() {
  await connectDb();
  await connectRedis();
  app.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`));
}

main().catch((e) => {
  console.error("startup failed:", e);
  process.exit(1);
});
