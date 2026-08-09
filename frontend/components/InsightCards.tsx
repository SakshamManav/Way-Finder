"use client";

import type { DecayItem, SeriesPoint, Spike } from "@/lib/api";

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(iso),
  );

const WHY_MATTERS: Record<Spike["metric"], string> = {
  complexity: "a jump this size makes this area harder to read and riskier to modify later.",
  coupling: "a change this size makes future edits in this area riskier and harder to review.",
};

const fmtValue = (v: number, isCx: boolean) =>
  isCx ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(Math.round(v));

export function RiskBadge({ level }: { level: DecayItem["risk_level"] }) {
  const styles: Record<string, string> = {
    high: "bg-red-500/15 text-red-300 border-red-500/40",
    medium: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    low: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  };
  return (
    <span className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${styles[level]}`}>
      {level} risk
    </span>
  );
}

function SpikeCard({ spike, series }: { spike: Spike; series: SeriesPoint[] }) {
  const isCx = spike.metric === "complexity";
  const pct = Math.round(spike.delta * 100);
  const gap = spike.gap_commits;
  const gapWord = `in ${gap} commit${gap === 1 ? "" : "s"}`;

  const idx = series.findIndex((p) => p.commit_sha === spike.commit_range[1]);
  const after = idx >= 0 ? series[idx] : undefined;
  const before = idx > 0 ? series[idx - 1] : undefined;
  const val = (pt: SeriesPoint | undefined) =>
    pt ? (isCx ? pt.avg_complexity : pt.total_edges) : null;
  const beforeVal = val(before);
  const afterVal = val(after);

  const name = isCx ? "Average complexity" : "Dependency coupling";
  const jump =
    beforeVal != null && afterVal != null
      ? `${name} jumped from ${fmtValue(beforeVal, isCx)} to ${fmtValue(afterVal, isCx)}${isCx ? "" : " connections"} (${pct}%) ${gapWord}`
      : `${name} jumped ${pct}% ${gapWord}`;

  return (
    <div
      className={`rounded-lg border p-4 ${
        isCx ? "border-amber-500/30 bg-amber-500/[0.04]" : "border-violet-500/30 bg-violet-500/[0.04]"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-[10px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded ${
            isCx ? "bg-amber-500/15 text-amber-300" : "bg-violet-500/15 text-violet-300"
          }`}
        >
          {isCx ? "complexity spike" : "coupling spike"}
        </span>
        <span className="text-xs text-slate-400 ml-auto font-mono whitespace-nowrap">
          {spike.commit_range[0].slice(0, 7)}…{spike.commit_range[1].slice(0, 7)}
          {after && <span className="text-slate-500"> · {fmtDate(after.commit_date)}</span>}
        </span>
      </div>
      <p className="text-sm text-slate-200 leading-relaxed">
        {jump} — {WHY_MATTERS[spike.metric]}
      </p>
      <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-500">
        Files responsible:
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {spike.affected_files.map((f) => (
          <span
            key={f}
            className="font-mono text-[11px] text-slate-400 bg-slate-800/70 px-1.5 py-0.5 rounded truncate max-w-[220px]"
          >
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

function DecayCard({ item }: { item: DecayItem }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <RiskBadge level={item.risk_level} />
        <span className="text-xs text-slate-400 ml-auto">
          idle {item.inactive_duration_days} days
        </span>
      </div>
      <p className="font-mono text-[13px] text-slate-100 truncate" title={item.path}>
        {item.path}
      </p>
      <p className="text-xs text-slate-400 mt-1.5">
        <span className="text-slate-300">{item.former_primary_owner}</span> wrote{" "}
        {(item.owner_commit_share * 100).toFixed(0)}% of commits · untouched since{" "}
        <span className="text-slate-300">{fmtDate(item.last_active_commit_date)}</span>
      </p>
    </div>
  );
}

export default function InsightCards({
  spikes,
  decayActive,
  series,
}: {
  spikes: Spike[];
  decayActive: DecayItem[];
  series: SeriesPoint[];
}) {
  const topSpikes = spikes.slice(0, 3);
  const topDecay = decayActive.slice(0, 3);

  return (
    <section className="mx-auto max-w-6xl px-4 mt-10">
      <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
        What the history says
        <span className="text-xs font-normal text-slate-500">
          the short version, first
        </span>
      </h2>
      <div className="mt-3 grid md:grid-cols-2 gap-4">
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wider text-slate-500">
              Complexity &amp; coupling spikes
            </h3>
            {topSpikes.length > 0 && (
              <span className="text-xs text-slate-500">
                {spikes.length} total flagged
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed mb-3">
            Coupling = how many files a change touches at once. Complexity = how
            much logic is packed into each file. Spikes here mean a change made
            the codebase measurably harder to work in.
          </p>
          {topSpikes.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              No jumps over the 25% threshold across sampled commits — this
              history grew steadily.
            </p>
          ) : (
            <div className="space-y-3">
              {topSpikes.map((s) => (
                <SpikeCard key={s.id} spike={s} series={series} />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wider text-slate-500">
              Ownership decay — files still in the tree
            </h3>
            {topDecay.length > 0 && (
              <span className="text-xs text-slate-500">
                {decayActive.length} at risk
              </span>
            )}
          </div>
          {topDecay.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              No files with a dominant owner that has gone quiet.
            </p>
          ) : (
            <div className="space-y-3">
              {topDecay.map((d) => (
                <DecayCard key={d.path} item={d} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
