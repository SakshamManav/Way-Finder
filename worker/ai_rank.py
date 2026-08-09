"""AI-assisted onboarding ranking (additive second pass).

Runs AFTER the deterministic structural ranking (indegree + complexity) and
refines only the top-N shortlist. Everything here is strictly optional:

  * Requires OPENROUTER_API_KEY (config via project-root .env or real env).
  * Fully disabled by ENABLE_AI_RANKING=false (pure structural ranking).
  * Never raises out of here: any network/parse/timeout failure falls back to
    that file's existing structural reason and score. One bad call cannot
    break the onboarding path.

The blended score is
`final_rank_score = normalized_structural * 0.5 + normalized_ai * 0.5`, where
BOTH inputs are normalized to 0..1 BEFORE blending:
`normalized_structural = indegree / max_indegree_in_repo` and
`normalized_ai = importance_score / 10`. Normalizing first keeps the two
signals on the same scale, so the AI importance score can only re-order files
that are structurally close to each other — it can never let a 0-importer file
jump a genuinely high-import-count hub (it would need an AI score ~2+ points
higher on the 10-point scale than the hub's, for the same 50/50 weight).

Results are cached on the onboarding_path doc itself (same per-repo+commit
pattern as the rest of the analysis): re-viewing a finished repo serves the
stored doc and never re-calls the API.
"""
import json
import os
import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import db
import envutil

# ---------------------------------------------------------------------------
# Configuration (single place to tweak; also overridable via env)
# ---------------------------------------------------------------------------
AI_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it:free")
AI_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
# Per-call timeout. Free-tier models are slow (several seconds + queueing), so
# this is generous; calls run concurrently, so batch wall-time stays bounded by
# the slowest call. Every call is individually fallback-safe.
AI_TIMEOUT_SECONDS = int(os.environ.get("AI_TIMEOUT_SECONDS", "45"))
AI_RETRIES = 2                # bounded retries on 429/5xx (free-tier throttling)
AI_RETRY_BACKOFF_S = (3, 6)
# Total attempts (successes AND retries) are throttled to this many per minute
# so a 25-file batch never trips OpenRouter's 20 RPM free-tier cap even while
# retrying. Overridable via env (e.g. 55 for a paid tier).
AI_RATE_LIMIT_RPM = float(os.environ.get("AI_RATE_LIMIT_RPM", "18"))
AI_MAX_CONCURRENT = int(os.environ.get("AI_MAX_CONCURRENT", "8"))
AI_STAGGER_S = 0.2            # stagger between request starts to ease rate limits
AI_TOP_N = 25                   # shortlist size (cost + latency control)
AI_CONTENT_LINE_LIMIT = 150     # first N lines are enough to classify
# Blend weights are deprecated: ordering is now AI-importance-first with
# structural centrality (import count) and complexity as tie-breakers. Kept
# only for reference.
STRUCTURAL_WEIGHT = 0.5
AI_WEIGHT = 0.5

AI_CATEGORIES = {
    "core-business-logic",
    "infrastructure",
    "reusable-utility",
    "config",
}

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")


def log(msg):
    os.makedirs(LOG_PATH, exist_ok=True)
    with open(os.path.join(LOG_PATH, "analyzer.log"), "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {msg}\n")
    print(msg, flush=True)


# Shared token-bucket rate limiter: keeps total requests (including retries)
# under AI_RATE_LIMIT_RPM per minute so a burst of 25 concurrent calls cannot
# trip the free tier's hard 20 RPM cap. Thread-safe via a global lock.
_rate_lock = threading.Lock()
_rate_bucket = {"tokens": AI_RATE_LIMIT_RPM, "last": time.time()}


def _acquire_rate_token():
    while True:
        with _rate_lock:
            now = time.time()
            refill = (now - _rate_bucket["last"]) * (AI_RATE_LIMIT_RPM / 60.0)
            _rate_bucket["tokens"] = min(AI_RATE_LIMIT_RPM,
                                         _rate_bucket["tokens"] + refill)
            _rate_bucket["last"] = now
            if _rate_bucket["tokens"] >= 1.0:
                _rate_bucket["tokens"] -= 1.0
                return
        time.sleep(0.25)


# Daily-quota bookkeeping: when OpenRouter reports the free-model daily cap is
# exhausted ("free-models-per-day" / "free usage limit"), log it ONCE per run
# instead of repeating it for every subsequent file. The same honest-fallback
# path also covers billing failures (no credits / can't bill) so the app never
# silently dies with a confusing error — it degrades to structural reasons and
# tells you why.
_quota_state = {"logged": False, "hits": 0, "reason": None}

_QUOTA_HINTS = ("free-models-per-day", "free usage limit")
_BILLING_HINTS = ("insufficient credits", "payment required", "add credits",
                  "not enough credits", "billing", "payment")


def _is_quota_exhausted(err_body):
    return any(hint in err_body for hint in _QUOTA_HINTS)


def _is_billing_error(err_body, code):
    if code == 402:
        return True
    if code in (401, 403) and any(hint in err_body for hint in _BILLING_HINTS):
        return True
    return False


def _note_quota_exhausted(reason):
    with _rate_lock:
        _quota_state["hits"] += 1
        _quota_state["reason"] = reason
        if not _quota_state["logged"]:
            _quota_state["logged"] = True
            if reason == "billing":
                log("*** AI UNAVAILABLE (BILLING): the OpenRouter account could "
                    "not be billed for the configured model. Files fell back to "
                    "structural reasons. Add credits at openrouter.ai/settings/"
                    "credits (or fix OPENROUTER_API_KEY), then re-analyze. ***")
            else:
                log("*** QUOTA EXHAUSTED: OpenRouter free-model daily limit reached "
                    "(~50 requests/day). Remaining files this run will fall back to "
                    "structural ranking. Add 10 credits for 1000 free requests/day, "
                    "or set OPENROUTER_MODEL to a paid model. ***")


def _reset_quota_state():
    with _rate_lock:
        _quota_state["logged"] = False
        _quota_state["hits"] = 0
        _quota_state["reason"] = None


def is_enabled():
    """True when the AI layer should run. Defaults ON if a key exists; the
    feature flag `ENABLE_AI_RANKING=false` always wins."""
    envutil.load_env()
    flag = os.environ.get("ENABLE_AI_RANKING", "true").strip().lower()
    if flag == "false":
        return False
    if not os.environ.get("OPENROUTER_API_KEY"):
        return False
    return True


def _structural_score(indegree, lo, hi):
    """Deprecated (kept for reference only). Structural normalization now uses
    `indegree / max_indegree_in_repo` -> 0..1 before blending, so both blend
    inputs share a 0..1 scale."""
    if hi <= lo:
        return 5.0
    return 1.0 + 9.0 * (indegree - lo) / (hi - lo)


def read_file_content(repo_path, rel_path, line_limit=AI_CONTENT_LINE_LIMIT):
    """First `line_limit` lines of a file from the checkout, or None."""
    full = os.path.join(repo_path, *rel_path.split("/"))
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    lines = text.splitlines()[:line_limit]
    return "\n".join(lines)


def build_prompt(path, stats, content, repo_ctx=None):
    ctx_lines = ""
    if repo_ctx:
        ctx_lines = (
            "\nRepo context: this is 1 of {n} files total. The most-imported "
            "file in the repo has {maxdeg} importers; this file ranks #{rk} by "
            "import count (1 = most imported). Top-imported files: {top}.\n"
        ).format(
            n=repo_ctx["total_files"],
            maxdeg=repo_ctx["max_indegree"],
            rk=repo_ctx["this_rank"],
            top=", ".join(repo_ctx["top_imported"]),
        )
    return (
        "You are analyzing one file from a codebase to help a new contributor "
        "understand what to read first. Given this file's content and stats, "
        'respond with ONLY valid JSON in this exact shape:\n'
        '{ "category": "core-business-logic" | "infrastructure" | '
        '"reusable-utility" | "config", "importance_score": <1-10>, '
        '"reason": "<one sentence, specific to this file, under 20 words>" }\n'
        "Scoring calibration - be STRICT and discriminating, not generous:\n"
        "  9-10 = truly foundational to the entire system (core data models, "
        "primary API entry points, auth/security core).\n"
        "  6-8 = important logic that is central but not foundational.\n"
        "  3-5 = standard feature/module code.\n"
        "  1-2 = utilities, boilerplate, glue, configuration.\n"
        "Anchors: a config file holding connection strings -> 2; a CRUD route "
        "used by a handful of pages -> 4; a model/schema almost every feature "
        "reads -> 8; the file that boots the app and wires everything -> 9.\n"
        "Be discriminating, not generous: most files you score should land in "
        "1-5. Reserve 8+ for only a handful of files per repo. If you find "
        "yourself scoring everything 6-8, you are being too generous - tighten.\n"
        f"{ctx_lines}"
        f"File path: {path}\n"
        f"Stats: {stats['indegree']} importers, complexity "
        f"{stats['complexity_score']}, {stats['loc']} lines\n"
        "Content:\n"
        f"{content}"
    )


def parse_ai_response(raw):
    """Extract {category, importance_score, reason} from model output. Returns
    None if the shape is wrong so the caller can fall back."""
    if not raw:
        return None
    text = str(raw).strip()
    # tolerate markdown fences
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except (ValueError, TypeError):
        return None
    category = data.get("category")
    if category not in AI_CATEGORIES:
        return None
    try:
        score = float(data.get("importance_score"))
    except (TypeError, ValueError):
        return None
    if not (1 <= score <= 10):
        return None
    reason = str(data.get("reason") or "").strip()
    if not reason:
        return None
    return {
        "category": category,
        "importance_score": round(score, 1),
        "reason": reason[:140],
    }


def classify_one(path, stats, content, api_key, model, base_url, timeout,
                repo_ctx=None):
    """One OpenRouter chat call. Returns parsed dict or None on ANY failure
    (network, HTTP error, timeout, bad JSON). Bounded retries on transient
    free-tier throttling (HTTP 429 / 5xx). Logs one outcome line per call so
    the actual success/429/timeout counts are visible in analyzer.log."""
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "user",
             "content": build_prompt(path, stats, content, repo_ctx)}
        ],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    t0 = time.time()
    attempts = 0
    statuses = []
    result = None
    last_error = ""
    for attempt in range(AI_RETRIES + 1):
        attempts += 1
        _acquire_rate_token()
        try:
            req = urllib.request.Request(
                base_url.rstrip("/") + "/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = json.loads(resp.read().decode("utf-8", errors="replace"))
            content_text = body["choices"][0]["message"]["content"]
            result = parse_ai_response(content_text)
            statuses.append(200 if result else 422)
            if result:
                break
        except urllib.error.HTTPError as e:
            statuses.append(e.code)
            try:
                err_body = e.read(300).decode("utf-8", errors="replace")
            except Exception:
                err_body = ""
            if e.code == 429 and _is_quota_exhausted(err_body):
                _note_quota_exhausted("quota")
                last_error = f"body={err_body[:180]!r}"
                break
            if _is_billing_error(err_body, e.code):
                _note_quota_exhausted("billing")
                last_error = f"body={err_body[:180]!r}"
                break
            if e.code in (429, 500, 502, 503, 504) and attempt < AI_RETRIES:
                wait = (AI_RETRY_BACKOFF_S[attempt]
                        if attempt < len(AI_RETRY_BACKOFF_S)
                        else AI_RETRY_BACKOFF_S[-1])
                if e.code == 429 and e.headers and e.headers.get("Retry-After"):
                    try:
                        wait = max(wait, min(30, int(float(e.headers["Retry-After"]))))
                    except (TypeError, ValueError):
                        pass
                last_error = f"body={err_body[:180]!r}"
                time.sleep(wait)
                continue
            last_error = f"body={err_body[:180]!r}"
        except Exception as e:
            statuses.append("timeout" if isinstance(e, urllib.error.URLError) else "error")
            last_error = f"{type(e).__name__}: {e}"
        if attempt < AI_RETRIES:
            time.sleep(AI_RETRY_BACKOFF_S[attempt])
    ms = int((time.time() - t0) * 1000)
    last = statuses[-1] if statuses else "error"
    if result:
        log(f"ai-call {path} status={last} attempts={attempts} ms={ms} "
            f"cat={result['category']} score={result['importance_score']}")
    else:
        log(f"ai-call {path} status={last} attempts={attempts} ms={ms} FALLBACK "
            f"({last_error})")
    return result


def apply_ai_ranking(repo_id, repo_path):
    """Phase 7: refine the stored onboarding path with AI classifications.

    Reads the structural onboarding_path doc, classifies the top-N shortlist
    concurrently (8s hard timeout each), then re-orders AI-first (importance
    score desc; import count and complexity break ties), and writes the result
    back onto the same doc. Pure no-op when disabled.
    """
    envutil.load_env()
    if not is_enabled():
        return None

    doc = db.onboarding_path.find_one({"repo_id": repo_id})
    if not doc or not doc.get("ordered_files"):
        return None

    ordered = list(doc["ordered_files"])
    t0 = time.time()
    _reset_quota_state()
    api_key = os.environ["OPENROUTER_API_KEY"]
    model = os.environ.get("OPENROUTER_MODEL", AI_MODEL)
    base_url = os.environ.get("OPENROUTER_BASE_URL", AI_BASE_URL)

    shortlist = ordered[:AI_TOP_N]
    max_deg = max((f["indegree"] for f in ordered), default=0)
    deg_sorted = sorted(ordered, key=lambda f: -f["indegree"])
    rank_of = {f["path"]: i + 1 for i, f in enumerate(deg_sorted)}
    repo_ctx_base = {
        "total_files": len(ordered),
        "max_indegree": max_deg,
        "top_imported": [f"{f['path']} ({f['indegree']})"
                         for f in deg_sorted[:5]],
    }

    tasks = []
    for f in shortlist:
        content = read_file_content(repo_path, f["path"])
        if content is None:
            content = ""
        stats = {"indegree": f["indegree"],
                 "complexity_score": f["complexity_score"],
                 "loc": f["loc"]}
        ctx = dict(repo_ctx_base)
        ctx["this_rank"] = rank_of.get(f["path"], len(deg_sorted))
        tasks.append((f["path"], stats, content, ctx))

    classified = {}
    workers = max(1, min(AI_MAX_CONCURRENT, len(tasks)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        def _run(path, stats, content, ctx, idx):
            time.sleep(idx * AI_STAGGER_S)
            return classify_one(path, stats, content,
                                api_key, model, base_url, AI_TIMEOUT_SECONDS,
                                repo_ctx=ctx)
        futures = [
            ex.submit(_run, path, stats, content, ctx, i)
            for i, (path, stats, content, ctx) in enumerate(tasks)
        ]
        for fut, (path, _, _, _) in zip(futures, tasks):
            result = fut.result()  # classify_one never raises
            if result:
                classified[path] = result

    max_deg = max((f["indegree"] for f in ordered), default=0)
    for f in ordered:
        ai = classified.get(f["path"])
        norm_structural = (f["indegree"] / max_deg) if max_deg > 0 else 0.0
        if ai:
            f["final_rank_score"] = round(ai["importance_score"], 1)
            f["ai_classified"] = True
            f["ai_category"] = ai["category"]
            f["ai_importance"] = ai["importance_score"]
            f["ai_reason"] = ai["reason"]
        else:
            f["final_rank_score"] = round(norm_structural, 4)
            f["ai_classified"] = False
            f["ai_category"] = None
            f["ai_importance"] = None
            f["ai_reason"] = None

    ordered.sort(key=lambda f: (
        0 if f.get("ai_classified") else 1,
        -(f.get("ai_importance") or 0.0),
        -f["indegree"],
        f["complexity_score"],
    ))
    for i, f in enumerate(ordered):
        f["rank"] = i + 1

    # --- debug: AI score distribution -------------------------------------
    ai_scores = sorted(c["importance_score"] for c in classified.values())
    dist = {}
    for s in ai_scores:
        dist[s] = dist.get(s, 0) + 1
    log(f"  ai-score distribution (n={len(ai_scores)}): "
        f"{dict(sorted(dist.items()))}")

    # --- debug: pre-blend numbers for the top N ----------------------------
    struct_order = sorted(ordered,
                          key=lambda f: (-f["indegree"], f["complexity_score"]))
    log("  pure-import-count order (reference): "
        + ", ".join(f"{f['path']}({f['indegree']})" for f in struct_order[:10]))
    log("  top-12 (rank | indeg | norm_struct | raw_ai | norm_ai | "
        "final=ai | path):")
    for f in ordered[:12]:
        raw_ai = f["ai_importance"] if f.get("ai_classified") else None
        norm_s = (f["indegree"] / max_deg) if max_deg > 0 else 0.0
        norm_a = (raw_ai / 10.0) if raw_ai is not None else None
        log(f"    #{f['rank']:>2} | {f['indegree']:>3} | {norm_s:.3f} | "
            f"{str(raw_ai) if raw_ai is not None else '-':>3} | "
            f"{f'{norm_a:.3f}' if norm_a is not None else '-':>6} | "
            f"{f['final_rank_score']:.4f} | {f['path']}")

    envelope = {
        "enabled": True,
        "model": model,
        "shortlist_count": len(shortlist),
        "classified_count": len(classified),
        "fallback_count": len(shortlist) - len(classified),
        "duration_ms": int((time.time() - t0) * 1000),
        "max_concurrent": workers,
        "rate_limit_rpm": AI_RATE_LIMIT_RPM,
        "retries": AI_RETRIES,
        "quota_exhausted": _quota_state["reason"] == "quota",
        "billing_failed": _quota_state["reason"] == "billing",
        "quota_hits": _quota_state["hits"],
        "blend": "ai-primary-structural-tiebreak",
        "normalized": True,
        "blended": True,
    }
    db.onboarding_path.update_one(
        {"_id": doc["_id"]},
        {"$set": {"ordered_files": ordered, "ai_ranking": envelope}},
    )
    log(f"  ai-ranking: {envelope}")
    return envelope
