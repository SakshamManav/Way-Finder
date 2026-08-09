"use client";

import type { AiRankingInfo, OnboardingFile } from "@/lib/api";

function cxTone(c: number): string {
  if (c >= 30) return "bg-red-500/15 text-red-300";
  if (c >= 15) return "bg-amber-500/15 text-amber-300";
  return "bg-emerald-500/15 text-emerald-300";
}

function AiStatusBanner({ aiRanking }: { aiRanking: AiRankingInfo | null }) {
  if (!aiRanking) {
    return (
      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-500">
        AI-assisted ranking was not enabled for this run.
      </div>
    );
  }
  if (aiRanking.quota_exhausted || aiRanking.billing_failed) {
    return (
      <div className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
        <span className="font-semibold text-amber-200">
          AI ranking was throttled or unavailable.
        </span>{" "}
        Only {aiRanking.classified_count} of {aiRanking.shortlist_count} top files
        got an AI assessment — the OpenRouter account had no usable quota or
        credits at the time. These files show structural reasons only. Add $10 in
        OpenRouter credits or switch <code>OPENROUTER_MODEL</code> to a paid
        model, then re-analyze.
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
      <span className="font-semibold text-emerald-200">
        AI-assisted ranking on.
      </span>{" "}
      {aiRanking.classified_count} of {aiRanking.shortlist_count} top files
      classified via{" "}
      <code className="text-emerald-200">{aiRanking.model}</code>, ordered by
      AI-assessed importance (import count breaks ties).
    </div>
  );
}

const AI_CATEGORY_META: Record<string, { label: string; className: string }> = {
  "core-business-logic": {
    label: "core logic",
    className: "bg-violet-500/15 text-violet-300 border border-violet-500/30",
  },
  infrastructure: {
    label: "infrastructure",
    className: "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30",
  },
  "reusable-utility": {
    label: "utility",
    className: "bg-teal-500/15 text-teal-300 border border-teal-500/30",
  },
  config: {
    label: "config",
    className: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
  },
};

export default function OnboardingChecklist({
  files,
  aiRanking,
}: {
  files: OnboardingFile[];
  aiRanking?: AiRankingInfo | null;
}) {
  return (
    <section className="mx-auto max-w-6xl px-4 mt-12">
      <h2 className="text-lg font-semibold text-slate-100">
        Onboarding path — what to read first
      </h2>
      <p className="text-sm text-slate-500 mt-1 max-w-2xl">
        Ranked by AI-assessed importance — the files that make up the heart of
        the system first, tapering down to helpers and glue. Test files are
        excluded.
      </p>
      <p className="text-xs text-slate-600 mt-1">
        Among files the AI ranks equally, the most-imported and simplest come
        first. If the AI layer is off, this falls back to pure dependency-graph
        order.
      </p>

      <AiStatusBanner aiRanking={aiRanking ?? null} />

      <ol className="mt-4 space-y-2">
        {files.map((f) => {
          const aiMeta = f.ai_category
            ? AI_CATEGORY_META[f.ai_category]
            : undefined;
          return (
            <li
              key={f.path}
              className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3"
            >
              <span className="mt-0.5 w-7 h-7 shrink-0 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-medium flex items-center justify-center">
                {f.rank}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[13px] text-slate-100 truncate">
                    {f.path}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${cxTone(f.complexity_score)}`}>
                    cx {f.complexity_score}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                    {f.indegree} importer{f.indegree === 1 ? "" : "s"}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">
                    {f.loc} LOC
                  </span>
                  {aiMeta && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full ${aiMeta.className}`}
                      title={`AI-assessed importance: ${f.ai_importance ?? "?"}/10`}
                    >
                      {aiMeta.label}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  {f.ai_reason ? f.ai_reason : f.reason}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
