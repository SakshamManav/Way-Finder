"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAnalysis } from "@/lib/api";
import Nav from "@/components/Nav";

const EXAMPLES = [
  { label: "expressjs/express", url: "https://github.com/expressjs/express" },
  { label: "axios/axios", url: "https://github.com/axios/axios" },
  { label: "psf/requests", url: "https://github.com/psf/requests" },
];

const PILLARS = [
  {
    n: "01",
    title: "When did this codebase get harder to work in?",
    body: "We sample commits across history, score complexity and coupling at each one, and flag the specific commit ranges where they jumped — not just a graph to eyeball.",
  },
  {
    n: "02",
    title: "What has nobody looking after it anymore?",
    body: "We find files that used to have one dominant owner and now sit untouched — bus-factor and ownership-decay risk, ranked by how long they've been neglected.",
  },
  {
    n: "03",
    title: "What order should I read the files in?",
    body: "We rank the codebase by AI-assessed importance — the files that form the heart of the system first — with import count breaking ties, each with a one-line reason.",
  },
];

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(repoUrl: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createAnalysis(repoUrl);
      router.push(`/analyze/${res.jobId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="flex-1">
        <section className="mx-auto max-w-3xl px-4 pt-16 pb-12 text-center">
          <p className="text-emerald-400/90 font-mono text-xs tracking-widest uppercase mb-4">
            git history diagnostics
          </p>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-50 leading-tight">
            Understand a codebase
            <br className="hidden sm:block" /> through its{" "}
            <span className="text-emerald-400">history</span>
          </h1>
          <p className="mt-5 text-slate-400 max-w-xl mx-auto">
            Paste any public GitHub repository. Wayfinder answers three
            questions a new contributor or maintainer actually cares about —
            when it got harder to work in, what nobody is maintaining, and what
            to read first.
          </p>

          <form
            className="mt-9 flex flex-col sm:flex-row gap-3 max-w-xl mx-auto"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) submit(url.trim());
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
            />
            <button
              type="submit"
              disabled={busy || !url.trim()}
              className="rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-medium px-6 py-3 text-sm transition-colors"
            >
              {busy ? "Analyzing…" : "Analyze repo"}
            </button>
          </form>

          {error && (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          )}

          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <span className="text-xs text-slate-500 self-center">Try:</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.url}
                onClick={() => submit(ex.url)}
                disabled={busy}
                className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50 transition-colors"
              >
                {ex.label}
              </button>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 pb-20 grid md:grid-cols-3 gap-4">
          {PILLARS.map((p) => (
            <div
              key={p.n}
              className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"
            >
              <div className="font-mono text-emerald-400/70 text-xs mb-2">
                {p.n}
              </div>
              <h2 className="text-slate-100 font-medium text-sm leading-snug mb-2">
                {p.title}
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed">{p.body}</p>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
