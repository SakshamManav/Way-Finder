import Link from "next/link";

export default function Nav() {
  return (
    <header className="border-b border-slate-800/70 bg-slate-950/80 backdrop-blur sticky top-0 z-20">
      <div className="mx-auto max-w-6xl px-4 py-3 flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 group">
          <span className="w-6 h-6 rounded bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M6 1v10M6 1L2.5 4.5M6 1l3.5 3.5M6 11l-3-3M6 11l3-3"
                stroke="#34d399"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="font-semibold tracking-tight text-slate-100">
            Wayfinder
          </span>
        </Link>
        <span className="hidden sm:block text-xs text-slate-500 ml-1">
          git history diagnostics
        </span>
      </div>
    </header>
  );
}
