"use client";

import { useMemo } from "react";
import type { SeriesPoint, Spike } from "@/lib/api";

interface Props {
  series: SeriesPoint[];
  spikes: Spike[];
  activeSha: string | null;
  loading: boolean;
  onSelect: (sha: string) => void;
}

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(iso),
  );

export default function TimelineScrubber({
  series,
  spikes,
  activeSha,
  loading,
  onSelect,
}: Props) {
  const current = useMemo(() => {
    if (!series.length) return null;
    const idx = series.findIndex((p) => p.commit_sha === activeSha);
    const i = idx >= 0 ? idx : series.length - 1;
    return { point: series[i], index: i };
  }, [series, activeSha]);

  const chart = useMemo(() => {
    if (series.length < 2) return null;
    const W = 640, H = 120, PAD = 6;
    const maxCx = Math.max(...series.map((p) => p.avg_complexity));
    const maxE = Math.max(...series.map((p) => p.total_edges), 1);
    const x = (i: number) => PAD + (i / (series.length - 1)) * (W - PAD * 2);
    const yCx = (v: number) => H - PAD - (v / maxCx) * (H - PAD * 2);
    const yE = (v: number) => H - PAD - (v / maxE) * (H - PAD * 2);
    const line = series.map((p, i) => `${x(i)},${yCx(p.avg_complexity)}`).join(" ");
    const edgeLine = series.map((p, i) => `${x(i)},${yE(p.total_edges)}`).join(" ");
    const spikeXs = spikes
      .map((s) => {
        const i = series.findIndex((p) => p.commit_sha === s.commit_range[1]);
        return i >= 0 ? x(i) : null;
      })
      .filter((v): v is number => v !== null);
    return { x, yCx, line, edgeLine, spikeXs, W, H, PAD };
  }, [series, spikes]);

  if (!series.length) {
    return (
      <section className="mx-auto max-w-6xl px-4 mt-12">
        <p className="text-sm text-slate-500">No sampled timeline available.</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-6xl px-4 mt-12">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold text-slate-100">Timeline scrubber</h2>
        {loading && <span className="text-xs text-slate-500">loading commit graph…</span>}
      </div>

      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        {current && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400 mb-3">
            <span className="font-mono text-slate-200">
              {current.point.commit_sha.slice(0, 8)}
            </span>
            <span>{fmtDate(current.point.commit_date)}</span>
            <span>
              avg complexity{" "}
              <span className="text-slate-200">{current.point.avg_complexity.toFixed(1)}</span>
            </span>
            <span>
              edges{" "}
              <span className="text-slate-200">{current.point.total_edges}</span>
            </span>
            <span>
              files <span className="text-slate-200">{current.point.total_files}</span>
            </span>
          </div>
        )}

        <div className="relative">
          <svg viewBox="0 0 640 120" className="w-full h-28" preserveAspectRatio="none">
            <defs>
              <linearGradient id="cxFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
              </linearGradient>
            </defs>
            {chart && (
              <>
                <polygon
                  points={`${chart.PAD},120 ${chart.line} ${chart.W - chart.PAD},120`}
                  fill="url(#cxFill)"
                />
                <polyline
                  points={chart.edgeLine}
                  fill="none"
                  stroke="#475569"
                  strokeWidth="1.2"
                  strokeOpacity="0.6"
                />
                <polyline
                  points={chart.line}
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth="1.8"
                />
                {chart.spikeXs.map((sx, i) => (
                  <g key={i}>
                    <line
                      x1={sx}
                      y1={chart.PAD}
                      x2={sx}
                      y2={120 - chart.PAD}
                      stroke="#f87171"
                      strokeWidth="1.2"
                      strokeDasharray="3 3"
                    />
                    <circle cx={sx} cy={chart.yCx(0)} r="3.5" fill="#f87171" />
                  </g>
                ))}
                {current && (
                  <line
                    x1={chart.x(current.index)}
                    y1={chart.PAD}
                    x2={chart.x(current.index)}
                    y2={120 - chart.PAD}
                    stroke="#e2e8f0"
                    strokeWidth="1.2"
                  />
                )}
              </>
            )}
          </svg>
          {chart && chart.spikeXs.length > 0 && (
            <span className="absolute top-0 right-0 text-[10px] text-red-400/80">
              red markers = flagged spikes
            </span>
          )}
        </div>

        <div className="mt-2 flex items-center gap-1">
          <span className="text-[10px] text-slate-500 shrink-0">
            {series[0] ? fmtDate(series[0].commit_date) : ""}
          </span>
          <input
            type="range"
            min={0}
            max={series.length - 1}
            value={current?.index ?? series.length - 1}
            onChange={(e) => onSelect(series[Number(e.target.value)].commit_sha)}
            className="flex-1 accent-indigo-500"
            aria-label="scrub through sampled commits"
          />
          <span className="text-[10px] text-slate-500 shrink-0">
            {series[series.length - 1] ? fmtDate(series[series.length - 1].commit_date) : ""}
          </span>
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          {series.length} sampled commits · solid = avg complexity, faint = dependency edges
        </p>
      </div>
    </section>
  );
}
