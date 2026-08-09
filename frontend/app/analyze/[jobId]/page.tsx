"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { getStatus, type JobStatus } from "@/lib/api";
import Nav from "@/components/Nav";

const STAGE_ORDER = ["clone", "sampling", "spikes", "ownership", "onboarding", "done"];

function stageLabel(status: JobStatus): string {
  if (status.progress?.message) return status.progress.message;
  switch (status.progress?.stage) {
    case "clone": return "Cloning repository…";
    case "sampling": return "Sampling commits…";
    case "spikes": return "Detecting complexity spikes…";
    case "ownership": return "Walking full history for ownership…";
    case "onboarding": return "Generating onboarding path…";
    case "done": return "Analysis complete";
    default: return status.status === "queued" ? "Queued…" : "Working…";
  }
}

function stagePercent(status: JobStatus): number {
  if (status.progress?.percent != null && status.progress.percent >= 0) {
    return status.progress.percent;
  }
  const idx = STAGE_ORDER.indexOf(status.progress?.stage || "");
  return idx < 0 ? 5 : Math.max(5, Math.round((idx / STAGE_ORDER.length) * 100));
}

export default function AnalyzePage() {
  const params = useParams<{ jobId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const cached = searchParams.get("cached");
  const jobId = String(params.jobId);

  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();
    const elapsedTimer = setInterval(
      () => setElapsed(Math.round((Date.now() - start) / 1000)),
      1000,
    );
    const tick = async () => {
      try {
        const s = await getStatus(jobId);
        if (cancelled) return;
        setStatus(s);
        if (s.status === "done") {
          if (pollRef.current) clearInterval(pollRef.current);
          // give the report a beat to be fully written, then jump
          setTimeout(() => router.replace(`/repo/${s.repoId}`), Math.max(0, 700 - (Date.now() - start)));
        } else if (s.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(s.error_message || "Analysis failed");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Lost contact with the analysis service");
        }
      }
    };
    tick();
    pollRef.current = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(elapsedTimer);
    };
  }, [jobId, router]);

  const pct = status ? stagePercent(status) : 4;
  const label = status ? stageLabel(status) : "Starting job…";

  return (
    <>
      <Nav />
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50 text-center">
            {cached === "true" ? "Report already ready" : "Analyzing repository"}
          </h1>
          <p className="text-sm text-slate-400 text-center mt-2">
            {status?.url || "…"}
          </p>

          <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
              </span>
              <span className="text-sm text-slate-200">{label}</span>
            </div>

            <div className="mt-4 h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${Math.max(4, Math.min(100, pct))}%` }}
              />
            </div>

            <div className="mt-3 flex justify-between text-xs text-slate-500">
              <span>{elapsed}s elapsed</span>
              <span>
                {status?.sampled_commit_count
                  ? `${status.sampled_commit_count} sampled commits`
                  : "…"}
              </span>
            </div>

            {status?.total_commits ? (
              <p className="mt-4 text-xs text-slate-500 leading-relaxed">
                Analyzing {status.total_commits} commits — we sample a subset
                for speed and run the full history walk for ownership.
              </p>
            ) : null}
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
              <p className="font-medium">Analysis failed</p>
              <p className="mt-1 text-red-400/80">{error}</p>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
