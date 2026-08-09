"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { GraphData } from "@/lib/api";
import type { Flag } from "./graphEncoding";
import { buildTree, collectDirPaths, topLevelDirPaths } from "./fileTreeModel";
import TreeDiagram from "./TreeDiagram";
import DependencyWeb from "./DependencyWeb";

type View = "tree" | "web";

interface Props {
  graph: GraphData;
  flags: Map<string, Flag>;
  onboardingRank: Map<string, number>;
  repoName?: string;
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs rounded-md px-2.5 py-1 transition-colors ${
        active ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

export default function DependencyGraph({ graph, flags, onboardingRank, repoName }: Props) {
  const [view, setView] = useState<View>("tree");
  const [open, setOpen] = useState(true);
  const [maximized, setMaximized] = useState(false);

  const roots = useMemo(() => buildTree(graph.nodes), [graph]);
  const dirCount = useMemo(() => collectDirPaths(roots).length, [roots]);
  // default: root folders expanded one level deep, deeper folders collapsed
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(topLevelDirPaths(roots)));

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const expandAll = () => setExpanded(new Set(collectDirPaths(roots)));
  const collapseAll = () => setExpanded(new Set());

  useEffect(() => {
    document.body.style.overflow = maximized ? "hidden" : "";
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pt-2.5">
        <h2 className="text-sm font-medium text-slate-100">Dependency graph</h2>
        <div className="flex items-center gap-2">
          {view === "tree" && (
            <button
              onClick={() => setMaximized(true)}
              title="Full screen"
              aria-label="Full screen"
              className="w-7 h-7 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 text-xs leading-none"
            >
              ⤢
            </button>
          )}
          <button
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded px-2 py-1"
          >
            {open ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2.5 pt-2">
        <div className="flex gap-0.5 bg-slate-800/60 rounded-lg p-0.5">
          <TabBtn active={view === "tree"} onClick={() => setView("tree")}>
            File tree
          </TabBtn>
          <TabBtn active={view === "web"} onClick={() => setView("web")}>
            View as dependency web
          </TabBtn>
        </div>
        <p className="text-[11px] text-slate-500">
          {view === "tree"
            ? `${graph.nodes.length} files · ${dirCount} folders`
            : "complexity & import links between files"}
        </p>
      </div>

      {open &&
        (view === "tree" ? (
          <div className="border-t border-slate-800 h-[460px]">
            <TreeDiagram
              roots={roots}
              expanded={expanded}
              onToggle={toggle}
              flags={flags}
              onboardingRank={onboardingRank}
              repoName={repoName}
            />
          </div>
        ) : (
          <div className="border-t border-slate-800">
            <DependencyWeb
              key={graph.commit_sha}
              graph={graph}
              flags={flags}
              onboardingRank={onboardingRank}
            />
          </div>
        ))}

      {maximized && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 backdrop-blur-sm">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 bg-slate-900">
            <h3 className="text-sm font-semibold text-slate-100">
              {repoName ? `${repoName} · ` : ""}Dependency tree
            </h3>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={expandAll}
                className="text-xs text-slate-300 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1"
              >
                Expand all
              </button>
              <button
                onClick={collapseAll}
                className="text-xs text-slate-300 hover:text-emerald-300 border border-slate-700 rounded px-2 py-1"
              >
                Collapse all
              </button>
              <button
                onClick={() => setMaximized(false)}
                aria-label="Close full screen"
                className="w-7 h-7 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-red-300 text-sm leading-none"
              >
                ×
              </button>
            </div>
          </div>
          <div className="flex-1 relative">
            <TreeDiagram
              panZoom
              roots={roots}
              expanded={expanded}
              onToggle={toggle}
              flags={flags}
              onboardingRank={onboardingRank}
              repoName={repoName}
            />
          </div>
        </div>
      )}
    </div>
  );
}
