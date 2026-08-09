# Wayfinder

**Git history diagnostics: paste a GitHub repo URL and get a report on where it got harder to maintain, which files nobody is watching anymore, and what a new contributor should read first.**

## The problem

Understanding an unfamiliar codebase is slow and manual. When you join a project or take over maintenance, you have to dig through commit history by hand to answer questions like:

- **When did this codebase get harder to work in?** Which change pushed complexity or coupling past a healthy point?
- **What has nobody looking after it anymore?** Which files used to have one owner and now sit untouched — a quiet bus-factor risk?
- **Where do I even start reading?** With hundreds of files, there's no obvious entry point.

Wayfinder turns that manual archaeology into an automatic report.

## What it does

Paste a public GitHub repo URL (or `owner/repo`), and Wayfinder produces a report with three core findings:

1. **Complexity & coupling spikes** — exact commit ranges where average complexity or dependency coupling jumped ≥25% between sampled commits, plus the files responsible.
2. **Ownership decay risk** — files whose former dominant owner went quiet, ranked by how long they've been neglected and flagged as *live risk* (file still in the tree) or *historical* (long deleted).
3. **AI-assisted onboarding path** — a reading order: the files that form the heart of the system first, each with a one-line reason. An optional LLM pass (OpenRouter) ranks the top files by assessed importance; without it, the order falls back to pure dependency-graph ranking.

The report also includes an interactive timeline scrubber and a file-tree/dependency-web visualization of the codebase at any sampled commit, with spikes and decay-risk files highlighted.

## Tech stack

| Layer | What it uses |
|---|---|
| **Frontend** | [Next.js 16](https://nextjs.org) (App Router), React 19, TypeScript 5, Tailwind CSS 4. Graph viz via `react-force-graph-2d`, `d3-force-3d`, `d3-hierarchy`. |
| **API** | [Express 4](https://expressjs.com), `cors`, `dotenv`, `ioredis`, MongoDB Node driver, `redis-memory-server` (auto-boots an embedded Redis for dev). |
| **Analysis worker** | Python 3 with `GitPython` (cloning + history), `radon` (real cyclomatic complexity for Python), `pymongo`, `redis`. |
| **Storage** | MongoDB (report data) + Redis (live progress ticks for the UI; optional). |
| **AI layer** | [OpenRouter](https://openrouter.ai) chat completions — default model `google/gemma-4-26b-a4b-it:free`, swap via `OPENROUTER_MODEL`. |

## Architecture

```
GitHub repo URL
      │
      ▼
┌─────────────┐   ┌──────────────────────┐   ┌──────────────────────────┐
│  Express API │──▶│  Python worker        │   │  MongoDB (report data)   │
│  (queues job) │   │  per repo, per job    │──▶│  Redis (progress ticks)  │
└─────────────┘   └──────────────────────┘   └──────────────────────────┘
      ▲                      │
      │                      ▼
┌─────────────┐   ┌──────────────────────┐
│  Next.js UI  │   │  clone → sample ~50   │
│  (poll +     │   │  commits → dependency │
│   report)     │   │  graph + complexity   │
└─────────────┘   │  per sample → spikes   │
                   │  → ownership decay    │
                   │  → onboarding path    │
                   │  → optional AI pass   │
                   └──────────────────────┘
```

The pipeline, in one pass over a repo:

1. **Clone** — a full (non-shallow) clone, because both history sampling and ownership analysis need the entire commit history.
2. **Sample commits** — target ~50 evenly spaced commits, always including the first and last.
3. **Extract dependency graph & score complexity** per sampled commit (regex import resolution; cyclomatic complexity for Python via radon, a documented branch/function/LOC proxy for JS/TS).
4. **Compute metrics** — per-file complexity, coupling (import edges), LOC, function count, plus indegree centrality on the final graph.
5. **Detect spikes** — any ≥25% jump in average complexity or dependency edges between consecutive samples is flagged with its commit range and the worst offenders.
6. **Detect ownership decay** — walk the *full* history once; find files whose top author wrote >60% of commits and that haven't been touched in ≥45 days.
7. **Generate onboarding path** — rank by import centrality, then optionally refine the top 25 files with an LLM importance score.
8. **Write everything to MongoDB** — the UI polls status via Redis-backed progress, then renders the report.

## How to run locally

### Prerequisites

- Node.js 20+ and npm
- Python 3.10+
- MongoDB running locally on `127.0.0.1:27017` (or set `WAYFINDER_MONGO_URL`)
- Redis is **optional** — if nothing is listening on `127.0.0.1:6379`, the API auto-boots an embedded Redis binary

### Setup

```bash
# 1. Configuration (secrets optional — the pipeline runs without them)
cp .env.example .env
#    optionally add: OPENROUTER_API_KEY=sk-or-v1-...

# 2. API (Express, port 4000)
cd api
npm install
npm run dev

# 3. Worker — the API spawns this automatically per job, so no server to run.
#    Dependencies only:
cd worker
python -m venv .venv
#     Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

# 4. Frontend (Next.js, port 3000)
cd frontend
npm install
npm run dev
```

Open http://localhost:3000, paste a GitHub URL (try `expressjs/express`, `axios/axios`, or `psf/requests`), and wait for the analysis.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | Enables the AI ranking pass. When unset, ranking is pure structural. | — |
| `OPENROUTER_MODEL` | LLM used for per-file classification. | `google/gemma-4-26b-a4b-it:free` |
| `OPENROUTER_BASE_URL` | Point the AI layer at any OpenAI-compatible endpoint. | `https://openrouter.ai/api/v1` |
| `ENABLE_AI_RANKING` | `false` hard-disables the AI layer. | `true` |
| `WAYFINDER_MONGO_URL` | MongoDB connection string. | `mongodb://127.0.0.1:27017` |
| `WAYFINDER_REDIS_HOST` / `WAYFINDER_REDIS_PORT` | Redis used for progress ticks. | `127.0.0.1` / `6379` |
| `PYTHON_BIN` | Python executable the API spawns for the worker. | `python` |
| `PORT` | API port. | `4000` |
| `NEXT_PUBLIC_API_URL` | Frontend → API base URL. | `http://localhost:4000` |

## Screenshots

> TODO — screenshots to be added (landing page, analysis progress, spike/decay report, onboarding checklist, dependency graph).

## Live demo

> TODO — not deployed yet. Link will go here.

## Known limitations

Honestly stated:

- **Language coverage** — JavaScript, TypeScript, and Python only. Other languages are skipped entirely.
- **Sampled, not exhaustive** — static analysis runs on ~50 sampled commits (always the first and last). Spike detection compares consecutive *samples*, so a sharp change that occurs between samples and then averages out could be missed. Ownership decay *does* use the full commit history.
- **Regex import parsing** — imports are extracted with a lightweight regex scanner, not a full parser. Rare over/under-matches on unusual syntax are possible, and cross-file type resolution is out of scope. Bare JS package specifiers are treated as external (except `@/` aliases); Python absolute imports resolve only against top-level or `src/` layouts.
- **Complexity is approximate for JS/TS** — a documented proxy (branch keywords + functions + imports + LOC). Python gets true cyclomatic complexity via radon.
- **Public GitHub repos only** — no authentication, so private repos won't clone.
- **Clones are full, not shallow** — required for accurate history, but large repos take longer.
- **Files over 500 KB and dependency-ish directories** (`node_modules`, `vendor`, `.next`, `public`, `docs`, …) are skipped.
- **AI ranking depends on OpenRouter** — the free tier caps at ~50 requests/day and can 429. Every AI call is individually fallback-safe: on any failure the file keeps its structural reason and score, and the report shows a banner when the quota was hit.

## Method (the short version)

Spikes: consecutive sampled commits compared; a jump ≥25% in average complexity or dependency edges is flagged with the commit range and the biggest contributors. Decay: per-path full-history commit counts; a file whose top contributor holds >60% of its commits and has been inactive ≥45 days is flagged, with risk scaling up to *high* past 180 days. Onboarding: files ranked by how many other files import them, ties broken by lower complexity, tests excluded; the AI pass then re-orders the top files by LLM-assessed importance.
