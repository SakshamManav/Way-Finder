"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  createAnalysis,
  getGraph,
  getReport,
  type GraphData,
  type Report,
} from "@/lib/api";
import Nav from "@/components/Nav";
import InsightCards from "@/components/InsightCards";
import OnboardingChecklist from "@/components/OnboardingChecklist";
import DependencyGraph from "@/components/DependencyGraph";
import TimelineScrubber from "@/components/TimelineScrubber";

const fmtAgo = (iso: string) => {
  const d = new Date(iso).getTime();
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

export default function RepoPage() {
  const params = useParams<{ repoId: string }>();
  const router = useRouter();
  const repoId = String(params.repoId);

  const [report, setReport] = useState<Report | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const reqCounter = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getReport(repoId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {
        if (cancelled) return;
        // 202-style: analysis not finished yet — bounce to the progress screen.
        router.replace(`/analyze/${repoId}`);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, router]);

  const loadGraph = useCallback(
    (sha?: string) => {
      const id = ++reqCounter.current;
      setGraphLoading(true);
      getGraph(repoId, sha)
        .then((g) => {
          if (reqCounter.current === id) {
            setGraph(g);
            setGraphLoading(false);
          }
        })
        .catch((e: Error) => {
          if (reqCounter.current === id) {
            setError(e.message);
            setGraphLoading(false);
          }
        });
    },
    [repoId],
  );

  useEffect(() => {
    if (!report) return;
    let cancelled = false;
    getGraph(repoId)
      .then((g) => {
        if (!cancelled) {
          setGraph(g);
          setGraphLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setGraphLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [report, repoId]);

  const flags = useMemo(() => {
    const m = new Map<string, "high" | "medium" | "spike">();
    if (report) {
      for (const d of report.decay.active) {
        if (d.risk_level !== "low") m.set(d.path, d.risk_level);
      }
      for (const s of report.spikes) {
        for (const f of s.affected_files) if (!m.has(f)) m.set(f, "spike");
      }
    }
    return m;
  }, [report]);
  const onboardingRank = useMemo(() => {
    const m = new Map<string, number>();
    if (report) {
      for (const f of report.onboarding.ordered_files) m.set(f.path, f.rank);
    }
    return m;
  }, [report]);

  if (error) {
    return (
      <>
        <Nav />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <p className="text-sm text-red-300">{error}</p>
            <button
              onClick={() => router.push("/")}
              className="mt-3 text-sm text-emerald-400 hover:text-emerald-300"
            >
              Start over
            </button>
          </div>
        </main>
      </>
    );
  }

  if (!report) {
    return (
      <>
        <Nav />
        <main className="flex-1 flex items-center justify-center px-4">
          <p className="text-sm text-slate-400 animate-pulse">Loading report…</p>
        </main>
      </>
    );
  }

  const { repo, sampling, spikes, decay, onboarding, series } = report;
  const repoName = repo.url.split("/").pop() || "Root";

  const reanalyze = async () => {
    setReanalyzing(true);
    try {
      const { jobId } = await createAnalysis(repo.url, { force: true });
      router.push(`/analyze/${jobId}`);
    } catch (e) {
      setReanalyzing(false);
      setError(e instanceof Error ? e.message : "Could not start re-analysis");
    }
  };

  return (
    <>
      <Nav />
      <main className="flex-1 pb-20">
        <header className="border-b border-slate-800 bg-slate-950/80">
          <div className="mx-auto max-w-6xl px-4 py-6">
            <p className="font-mono text-sm text-emerald-400 truncate">{repo.url}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>
                {repo.default_branch ? `branch ${repo.default_branch}` : "no default branch"}
              </span>
              <span>{repo.total_commits} commits in full history</span>
              <span>{repo.sampled_commit_count} sampled for static analysis</span>
              <span>analyzed {fmtAgo(repo.last_analyzed_at)}</span>
              <button
                onClick={reanalyze}
                disabled={reanalyzing}
                className="ml-auto text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
              >
                {reanalyzing ? "queuing…" : "re-analyze"}
              </button>
            </div>
            <p className="mt-3 text-xs text-slate-600 max-w-2xl leading-relaxed">
              {sampling.message}
            </p>
            <p className="mt-4 text-sm text-slate-300 max-w-2xl leading-relaxed">
              Instead of reading commit history yourself, this shows where the
              codebase got harder to maintain, which files nobody&apos;s actively
              watching anymore, and the order a new contributor should read them
              in.
            </p>
          </div>
        </header>

        <InsightCards spikes={spikes} decayActive={decay.active} series={series} />

        <section className="mx-auto max-w-6xl px-4 mt-12">
          {graph ? (
              <DependencyGraph
                graph={graph}
                flags={flags}
                onboardingRank={onboardingRank}
                repoName={repoName}
              />
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-10 text-center text-sm text-slate-500">
                {graphLoading ? "building graph…" : "no graph data"}
              </div>
            )}
        </section>

        <TimelineScrubber
          series={series}
          spikes={spikes}
          activeSha={graph?.commit_sha ?? null}
          loading={graphLoading}
          onSelect={loadGraph}
        />

        <OnboardingChecklist
          files={onboarding.ordered_files}
          aiRanking={onboarding.ai_ranking ?? null}
        />

        <footer className="mx-auto max-w-6xl px-4 mt-12 text-xs text-slate-600 leading-relaxed">
          <h3 className="text-slate-500 font-medium mb-1">Method</h3>
          <p>
            Spikes: sampled commits compared to the previous sample; a jump ≥25%
            in avg complexity or dependency edges is flagged, with the worst
            offenders listed. Ownership: full-history commit counts per path; a
            file whose top contributor holds &gt;60% of its commits and has been
            inactive ≥45 days shows decay risk. Onboarding: files ranked by
            AI-assessed importance (import count breaks ties; complexity
            second); tests excluded. When the AI layer is off, files rank by
            import indegree (most-imported first), ties broken by lower
            complexity. Complexity = cyclomatic (radon) for
            Python, a branch/call proxy for JS/TS.
          </p>
          <p className="mt-2">
            AI pass: the top-ranked files are optionally classified by an LLM
            (category, importance, one-line reason) and that importance score
            drives the reading order. On the free OpenRouter tier this is
            capped at ~50 requests/day — the banner above shows when that limit
            was hit.
          </p>
        </footer>
      </main>
    </>
  );
}
