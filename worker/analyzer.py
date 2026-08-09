"""Wayfinder analysis worker.

Usage:
    python analyzer.py <repo_id> [repo_url]

Drives the whole pipeline against ONE repository:
  1. clone + commit sampling            (sampled, not every commit)
  2. dependency graph per sampled commit (regex import parsing)
  3. complexity scoring per file
  4. spike detection (complexity & coupling jumps)
  5. ownership decay (per-file real commit history)
  6. onboarding path generation (centrality + complexity ranking)

Job state lives in MongoDB (status) with progress ticks in Redis. The Express
API polls both.

The Express API spawns this as a detached child process per job; there is no
message broker because a solo-hackathon job volume never needs one.
"""
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
from collections import Counter, defaultdict
from datetime import datetime

import git
from bson import ObjectId

import ai_rank
import db
import envutil
import metrics

TARGET_SAMPLE_COUNT = 50
SPIKE_THRESHOLD = 0.25  # flag a jump >= 25% between sampled commits

# Ownership decay cutoffs (documented in the report UI):
#   * owner_commit_share > 0.6  -> there WAS a dominant owner
#   * file untouched for >= 45 days relative to the repo's latest commit
#   * risk scales with share and inactivity length.
DECAY_MIN_SHARE = 0.6
DECAY_MIN_INACTIVE_DAYS = 45
DECAY_HIGH_DAYS = 180
DECAY_MEDIUM_DAYS = 90

# Files excluded from the onboarding reading list (they're still analyzed).
# index.* hubs are intentionally kept: they're usually high-traffic re-export
# points that ARE good onboarding material.
ONBOARDING_EXCLUDE_RE = re.compile(
    r"(?:^|/)(?:__tests__|test|tests|spec|__test__|test-helpers)[^/]*/|"
    r"\.test\.|\.spec\.|_test\.py$|__main__$|\.d\.ts$"
)

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")


def log(msg):
    os.makedirs(LOG_PATH, exist_ok=True)
    with open(os.path.join(LOG_PATH, "analyzer.log"), "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Step 1: clone + sampling
# ---------------------------------------------------------------------------
def normalize_repo_url(url):
    url = url.strip().removesuffix("/").removesuffix(".git")
    if "github.com/" in url:
        url = url.split("github.com/")[1]
    parts = [p for p in url.split("/") if p]
    if len(parts) < 2:
        raise ValueError(f"Not a GitHub repo URL: {url}")
    return f"https://github.com/{parts[0]}/{parts[1]}"


def clone_repo(url, tmp):
    name = url.rstrip("/").split("/")[-1]
    target = os.path.join(tmp, name)
    # Full (non-shallow) clone: we need the entire history for sampling and
    # ownership decay, so depth filters would break the analysis.
    git.Repo.clone_from(url, target, depth=None)
    return target


def collect_commits(g):
    """All commit SHAs, oldest first (by commit date)."""
    shas = [c.hexsha for c in g.iter_commits()]
    shas.reverse()
    return shas


def choose_sample_indices(total, target=TARGET_SAMPLE_COUNT):
    """Pick ~`target` evenly spaced indices; always include first and last."""
    if total <= target:
        return list(range(total))
    step = total / target
    idx = sorted({int(i * step) for i in range(target)})
    idx[0] = 0
    idx[-1] = total - 1
    return idx


# ---------------------------------------------------------------------------
# Step 2 + 3: per-sample tree analysis
# ---------------------------------------------------------------------------
def analyze_tree_at_commit(g, sha, repo_id):
    commit = g.commit(sha)
    blobs = []
    repo_files = set()
    for entry in commit.tree.traverse():
        if entry.type != "blob":
            continue
        path = entry.path
        if metrics.should_skip_path(path):
            continue
        ext = os.path.splitext(path)[1]
        if ext not in metrics.SOURCE_EXTENSIONS:
            continue
        try:
            if entry.size > metrics.MAX_FILE_BYTES:
                continue
            data = entry.data_stream.read()
        except Exception:
            continue
        repo_files.add(path)
        blobs.append((path, ext, data))

    stem_map = metrics.build_stem_map(repo_files)
    files = []
    for path, ext, data in blobs:
        code = data.decode("utf-8", errors="replace")
        try:
            files.append(metrics.analyze_file(path, ext, code, repo_files, stem_map))
        except Exception:
            continue

    total_complexity = sum(f["complexity_score"] for f in files)
    total_edges = sum(len(f["imports"]) for f in files)
    total_files = len(files)
    return {
        "repo_id": repo_id,
        "commit_sha": sha,
        "commit_date": commit.committed_datetime,
        "author": commit.author.name or commit.author.email,
        "files": files,
        "total_complexity": total_complexity,
        "total_files": total_files,
        "total_edges": total_edges,
        "avg_complexity": (total_complexity / total_files) if total_files else 0,
    }


# ---------------------------------------------------------------------------
# Step 4: spike detection
# ---------------------------------------------------------------------------
def top_growth_files(prev_files_map, cur_files_map, limit=5, key="complexity_score"):
    growth = []
    for path, cur in cur_files_map.items():
        base = prev_files_map.get(path, {}).get(key, 0)
        g = cur.get(key, 0) - base
        if g > 0:
            growth.append((g, path))
    growth.sort(reverse=True)
    return [p for _, p in growth[:limit]]


def spike_reason(metric, delta, gap, from_sha, to_sha, files):
    if metric == "avg_complexity":
        verb = "Average complexity"
    else:
        verb = "Dependency coupling"
    if files:
        return (f"{verb} jumped {delta*100:.0f}% over {gap} commits "
                f"({from_sha[:7]}..{to_sha[:7]}). Biggest contributors: {', '.join(files)}.")
    return (f"{verb} jumped {delta*100:.0f}% over {gap} commits "
            f"({from_sha[:7]}..{to_sha[:7]}).")


def detect_spikes(repo_id, samples, sha_to_index, total_commits):
    db.flagged_spikes.delete_many({"repo_id": repo_id})
    prev = None
    inserted = 0
    for cur in samples:
        if prev is None:
            prev = cur
            continue
        cur_sha, prev_sha = cur["commit_sha"], prev["commit_sha"]
        gap = sha_to_index.get(cur_sha, 0) - sha_to_index.get(prev_sha, 0)
        gap = max(gap, 1)
        prev_files = {f["path"]: f for f in prev["files"]}
        cur_files = {f["path"]: f for f in cur["files"]}

        for metric in ("avg_complexity", "total_edges"):
            base = prev.get(metric, 0)
            if base and base > 0:
                delta = (cur.get(metric, 0) - base) / base
                if delta >= SPIKE_THRESHOLD:
                    key = "complexity_score" if metric == "avg_complexity" else "import_count"
                    files = top_growth_files(prev_files, cur_files, limit=5, key=key)
                    db.flagged_spikes.insert_one({
                        "repo_id": repo_id,
                        "commit_sha_range": [prev_sha, cur_sha],
                        "metric": "complexity" if metric == "avg_complexity" else "coupling",
                        "delta": round(delta, 4),
                        "gap_commits": gap,
                        "affected_files": files,
                        "human_readable_reason": spike_reason(
                            metric, delta, gap, prev_sha, cur_sha, files),
                    })
                    inserted += 1
        prev = cur
    db.repos.update_one({"_id": repo_id},
                        {"$set": {"spike_count": inserted}})
    log(f"  spikes: {inserted}")


# ---------------------------------------------------------------------------
# Step 5: ownership decay (full history, per file)
# ---------------------------------------------------------------------------
def ownership_decay(repo_id, repo_path, source_exts, final_paths=None):
    """Walk the FULL commit history (not sampled) and, per source file, find
    the primary owner and how long the file has gone untouched.

    Built on a single `git log --name-only` invocation (via GitPython's git
    wrapper). This is the same structured data pydriller/GitPython produce
    internally, but batched into ONE subprocess instead of ~1 per commit —
    the per-commit `commit.stats` loop cost 200s on a 1.3k-commit repo on
    Windows. Merge commits appear with no file list, so they are skipped by
    construction (a merge re-lists merged files but is not an author editing
    the file).

    `final_paths` (paths present in the latest sampled commit) lets us flag
    whether a decayed file STILL EXISTS — a live file with no maintainer is
    an active risk; a long-deleted one is historical context."""
    final_paths = final_paths or set()
    db.file_metrics.delete_many({"repo_id": repo_id})
    db.ownership_decay.delete_many({"repo_id": repo_id})

    repo = git.Repo(repo_path)
    out = repo.git.log(
        "--format=%x00%H%x01%ct%x01%an%x01%ae", "--name-only", "--no-renames")

    file_hist = defaultdict(list)  # path -> [(author_email, author_name, date, sha)]
    repo_last_ts = None
    for block in out.split("\x00"):
        block = block.rstrip("\n")
        if not block:
            continue
        lines = block.split("\n")
        meta = lines[0].split("\x01")
        if len(meta) < 4:
            continue
        sha, ts_str, name, email = meta[0], meta[1], meta[2], meta[3]
        try:
            ts = int(ts_str)
        except ValueError:
            continue
        date = datetime.fromtimestamp(ts)
        if repo_last_ts is None or ts > repo_last_ts:
            repo_last_ts = ts
        for p in lines[1:]:
            p = p.strip()
            if not p:
                continue
            path = metrics.norm(p)
            file_hist[path].append((email, name, date, sha))

    file_metrics_docs = []
    decay_docs = []
    last_date_ts = datetime.fromtimestamp(repo_last_ts) if repo_last_ts else None

    for path, entries in file_hist.items():
        ext = os.path.splitext(path)[1]
        if ext not in source_exts:
            continue
        entries_sorted = sorted(entries, key=lambda e: e[2])
        emails = Counter(e[0] for e in entries)
        top_email, top_count = emails.most_common(1)[0]
        share = top_count / len(entries)
        first_sha = entries_sorted[0][3]
        last_sha = entries_sorted[-1][3]
        last_date = entries_sorted[-1][2]
        first_date = entries_sorted[0][2]
        owner_name = next((n for e, n, _, _ in entries if e == top_email), top_email)

        file_metrics_docs.append({
            "repo_id": repo_id,
            "path": path,
            "first_seen_commit": first_sha,
            "first_seen_date": first_date,
            "last_modified_commit": last_sha,
            "last_modified_date": last_date,
            "primary_owner": owner_name,
            "owner_commit_share": round(share, 3),
            "commit_count": len(entries),
        })

        inactive = (last_date_ts - last_date).days if last_date_ts else 0
        if share > DECAY_MIN_SHARE and inactive >= DECAY_MIN_INACTIVE_DAYS:
            if share >= 0.8 and inactive >= DECAY_HIGH_DAYS:
                risk = "high"
            elif inactive >= DECAY_MEDIUM_DAYS:
                risk = "medium"
            else:
                risk = "low"
            decay_docs.append({
                "repo_id": repo_id,
                "path": path,
                "former_primary_owner": owner_name,
                "last_active_commit_date": last_date,
                "inactive_duration_days": inactive,
                "owner_commit_share": round(share, 3),
                "risk_level": risk,
                "still_exists": path in final_paths,
            })

    if file_metrics_docs:
        db.file_metrics.insert_many(file_metrics_docs)
    if decay_docs:
        db.ownership_decay.insert_many(decay_docs)
    log(f"  file_metrics: {len(file_metrics_docs)}, decay flags: {len(decay_docs)}")


# ---------------------------------------------------------------------------
# Step 6: onboarding path
# ---------------------------------------------------------------------------
def onboarding_reason(indegree, complexity, is_leaf):
    if indegree >= 8:
        base = (f"Imported by {indegree} other files - the backbone of the system; "
                f"reading it first makes everything else click.")
    elif indegree >= 3:
        base = f"Imported by {indegree} files - understanding it unlocks those dependents."
    elif indegree >= 1:
        base = f"Imported by {indegree} file(s) - a shared building block."
    else:
        base = "Not imported by any other file - a leaf module, safe to read standalone."

    if complexity >= 30:
        return base + " High complexity: skim, don't read line-by-line."
    if complexity <= 10:
        return base + " Low complexity - quick and easy to follow."
    return base


def onboarding_path(repo_id, final_sample):
    db.onboarding_path.delete_many({"repo_id": repo_id})

    indegree = defaultdict(int)
    for f in final_sample["files"]:
        for imp in f["imports"]:
            indegree[imp] += 1

    ranked = []
    for f in final_sample["files"]:
        path = f["path"]
        if ONBOARDING_EXCLUDE_RE.search(path):
            continue
        ranked.append({
            "path": path,
            "rank": 0,
            "indegree": indegree.get(path, 0),
            "complexity_score": f["complexity_score"],
            "loc": f["loc"],
        })

    ranked.sort(key=lambda r: (-r["indegree"], r["complexity_score"]))
    for i, r in enumerate(ranked):
        r["rank"] = i + 1
        r["reason"] = onboarding_reason(r["indegree"], r["complexity_score"],
                                        r["indegree"] == 0)

    ordered = [
        {"path": r["path"], "rank": r["rank"], "reason": r["reason"],
         "complexity_score": r["complexity_score"], "loc": r["loc"],
         "indegree": r["indegree"]}
        for r in ranked
    ]
    db.onboarding_path.insert_one({
        "repo_id": repo_id,
        "ordered_files": ordered,
        "generated_from_commit": final_sample["commit_sha"],
    })

    # Push final-graph centrality into file_metrics.
    for f in final_sample["files"]:
        db.file_metrics.update_one(
            {"repo_id": repo_id, "path": f["path"]},
            {"$set": {"centrality_score": indegree.get(f["path"], 0),
                      "final_complexity": f["complexity_score"],
                      "final_loc": f["loc"]}})

    log(f"  onboarding files: {len(ordered)}")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def run(repo_id, url):
    envutil.load_env()
    repo_id = ObjectId(repo_id)
    url = normalize_repo_url(url)

    db.set_status(repo_id, "running", repo_url=url)
    db.set_progress(repo_id, "clone", "Cloning repository…", 5)
    log(f"analyzing {url}")

    tmp = tempfile.mkdtemp(prefix="wayfinder-")
    try:
        # Full clone: we need the entire history for sampling and ownership.
        t = _t0 = time.time()
        repo_path = clone_repo(url, tmp)
        log(f"  phase clone: {time.time()-t:.1f}s")
        g = git.Repo(repo_path)
        db.set_status(repo_id, "running",
                      default_branch=g.head.ref.name or "main")

        # --- 1. commit list + sampling ---
        t = time.time()
        all_shas = collect_commits(g)
        total = len(all_shas)
        if total == 0:
            raise ValueError("No commits found in repository")
        sha_to_index = {sha: i for i, sha in enumerate(all_shas)}
        sample_idx = choose_sample_indices(total)
        sample_shas = [all_shas[i] for i in sample_idx]
        db.set_status(repo_id, "running",
                      total_commits=total,
                      sampled_commit_count=len(sample_shas))
        log(f"  phase sampling-prep: {time.time()-t:.1f}s (commits={total})")

        # --- 2+3. per-sample static analysis ---
        t = time.time()
        db.commit_samples.delete_many({"repo_id": repo_id})
        samples = []
        for i, sha in enumerate(sample_shas):
            pct = 10 + int(60 * (i + 1) / len(sample_shas))
            db.set_progress(repo_id, "sampling",
                            f"Sampling commits ({i + 1}/{len(sample_shas)})…", pct)
            doc = analyze_tree_at_commit(g, sha, repo_id)
            db.commit_samples.insert_one(doc)
            samples.append(doc)
        log(f"  phase sampling: {time.time()-t:.1f}s")

        # --- 4. spikes ---
        t = time.time()
        db.set_progress(repo_id, "spikes", "Detecting complexity spikes…", 74)
        detect_spikes(repo_id, samples, sha_to_index, total)
        log(f"  phase spikes: {time.time()-t:.1f}s")

        # --- 5. ownership decay (full history) ---
        t = time.time()
        db.set_progress(repo_id, "ownership",
                        "Walking full history for ownership…", 80)
        final_paths = {f["path"] for f in samples[-1]["files"]}
        ownership_decay(repo_id, repo_path, metrics.SOURCE_EXTENSIONS, final_paths)
        log(f"  phase ownership: {time.time()-t:.1f}s")

        # --- 6. onboarding ---
        t = time.time()
        db.set_progress(repo_id, "onboarding", "Generating onboarding path…", 92)
        onboarding_path(repo_id, samples[-1])
        log(f"  phase onboarding: {time.time()-t:.1f}s")

        # --- 7. AI-assisted ranking (additive, optional) ---
        # Never fails the job: ai_rank.apply_ai_ranking is a self-contained
        # no-op unless ENABLE_AI_RANKING + OPENROUTER_API_KEY are configured.
        t = time.time()
        db.set_progress(repo_id, "ai", "AI-validating onboarding path…", 96)
        try:
            ai_rank.apply_ai_ranking(repo_id, repo_path)
            log(f"  phase ai: {time.time()-t:.1f}s")
        except Exception as e:
            log(f"  phase ai: skipped ({e})")

        g.close()
        db.set_status(repo_id, "done",
                      last_analyzed_at=datetime.utcnow())
        db.set_progress(repo_id, "done", "Analysis complete", 100)
        log(f"TOTAL: {time.time()-_t0:.1f}s")
        return 0
    except Exception as e:
        log("FAILED:\n" + traceback.format_exc())
        try:
            db.set_status(repo_id, "failed", error_message=str(e)[:500])
            db.set_progress(repo_id, "failed", f"Analysis failed: {e}", -1)
        except Exception:
            pass
        return 1
    finally:
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


def main():
    if len(sys.argv) < 3:
        print("usage: python analyzer.py <repo_id> <repo_url>")
        return 2
    db.ping()
    sys.exit(run(sys.argv[1], sys.argv[2]))


if __name__ == "__main__":
    main()
