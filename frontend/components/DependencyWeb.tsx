"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { forceCollide } from "d3-force-3d";
import type { ForceGraphMethods } from "react-force-graph-2d";
import type { GraphData, GraphNode } from "@/lib/api";
import { baseColor, RING, type Flag } from "./graphEncoding";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type GraphRef = ForceGraphMethods;

interface Props {
  graph: GraphData;
  flags: Map<string, Flag>;
  onboardingRank: Map<string, number>;
}

const HEIGHT = 340;
// nodes with a circle below this radius only get a label on hover
const MIN_LABEL_RADIUS = 7.5;

function nodeRadius(node: { val?: number }): number {
  return Math.min(16, (node.val || 1) + 2);
}

export default function DependencyWeb({ graph, flags, onboardingRank }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphRef | undefined>(undefined);
  const labelRects = useRef<Array<{ x: number; y: number; w: number; h: number }>>([]);
  const didFit = useRef(false);

  const [size, setSize] = useState({ width: 0, height: HEIGHT });
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [showIsolated, setShowIsolated] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize((s) => ({ ...s, width: el.clientWidth }));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const { nodes, links, isolated } = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    const connected: GraphNode[] = [];
    const orphan: GraphNode[] = [];
    for (const n of graph.nodes) {
      ((degree.get(n.path) || 0) > 0 ? connected : orphan).push(n);
    }
    const connIds = new Set(connected.map((n) => n.path));

    const connectedNodes = connected.map((n) => ({
      id: n.path,
      path: n.path,
      complexity_score: n.complexity_score,
      loc: n.loc,
      import_count: n.import_count,
      function_count: n.function_count,
      val: 2 + Math.log1p(n.complexity_score || 1) * 2.2,
      degree: degree.get(n.path) || 0,
      highlighted:
        (degree.get(n.path) || 0) >= 5 ||
        n.complexity_score >= 25 ||
        flags.has(n.path),
    }));
    // higher-priority labels drawn first so they claim space
    connectedNodes.sort((a, b) => Number(b.highlighted) - Number(a.highlighted));

    orphan.sort((a, b) => (b.complexity_score || 0) - (a.complexity_score || 0));

    return {
      nodes: connectedNodes,
      links: graph.edges
        .filter((e) => connIds.has(e.source) && connIds.has(e.target))
        .map((e) => ({ source: e.source, target: e.target })),
      isolated: orphan,
    };
  }, [graph, flags]);

  // stronger repulsion + node collision so connected nodes settle apart and
  // bigger circles never sit on top of smaller ones
  useEffect(() => {
    const g = graphRef.current;
    if (!g || size.width === 0 || nodes.length === 0) return;
    const charge = g.d3Force("charge");
    if (charge) charge.strength(-45);
    g.d3Force(
      "collide",
      forceCollide()
        .radius((n: unknown) => nodeRadius(n as { val?: number }) + 2.5)
        .strength(0.85)
        .iterations(2),
    );
    const linkForce = g.d3Force("link");
    if (linkForce) linkForce.distance(40);
    g.d3ReheatSimulation();
  }, [nodes, size.width]);

  const drawLabel = (
    n: { x: number; y: number; val: number; path: string },
    ctx: CanvasRenderingContext2D,
    globalScale: number,
  ) => {
    const label = n.path.split("/").pop() || n.path;
    ctx.font = `${10 / globalScale}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    const pad = 4 / globalScale;
    const lh = 12 / globalScale;
    const tw = ctx.measureText(label).width;
    const bx = n.x + n.val + pad;
    const by = n.y - lh / 2;
    const rect = { x: bx, y: by, w: tw + pad * 2, h: lh + 1 };
    const gap = 3 / globalScale;
    const overlaps = labelRects.current.some(
      (r) =>
        rect.x < r.x + r.w + gap &&
        r.x < rect.x + rect.w + gap &&
        rect.y < r.y + r.h + gap &&
        r.y < rect.y + rect.h + gap,
    );
    if (overlaps) return;
    ctx.fillStyle = "rgba(15,23,42,0.85)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(label, bx + pad, by);
    labelRects.current.push(rect);
  };

  const drawNode = (
    node: unknown,
    ctx: CanvasRenderingContext2D,
    globalScale: number,
  ) => {
    const n = node as {
      x: number;
      y: number;
      val: number;
      path: string;
      complexity_score: number;
      highlighted: boolean;
    };
    const r = Math.min(16, n.val);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = baseColor(n.complexity_score);
    ctx.fill();

    const flag = flags.get(n.path);
    if (flag) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 2.5, 0, 2 * Math.PI);
      ctx.strokeStyle = RING[flag];
      ctx.lineWidth = 1.6 / globalScale;
      ctx.stroke();
    }

    if (n.highlighted && n.val >= MIN_LABEL_RADIUS) drawLabel(n, ctx, globalScale);
  };

  const zoomIn = () => {
    const g = graphRef.current;
    if (!g) return;
    g.zoom(Math.min(g.zoom() * 1.6, 8), 200);
  };
  const zoomOut = () => {
    const g = graphRef.current;
    if (!g) return;
    g.zoom(Math.max(g.zoom() / 1.6, 0.05), 200);
  };
  const zoomFit = () => graphRef.current?.zoomToFit(300, 40);

  return (
    <div>
      <div className="relative w-full" style={{ height: HEIGHT }}>
        <div ref={containerRef} className="w-full h-full">
          {size.width > 0 && nodes.length > 0 && (
            <ForceGraph2D
              ref={graphRef}
              width={size.width}
              height={size.height}
              graphData={{ nodes, links }}
              nodeCanvasObject={drawNode}
              nodeCanvasObjectMode={() => "replace"}
              nodeLabel={(node: unknown) => {
                const n = node as { path: string };
                return n.path;
              }}
              linkColor={() => "#1e293b"}
              linkWidth={1}
              backgroundColor="transparent"
              cooldownTicks={150}
              onRenderFramePost={() => {
                labelRects.current = [];
              }}
              onEngineStop={() => {
                if (!didFit.current) {
                  didFit.current = true;
                  // no-animation so the whole graph is framed the moment layout settles
                  graphRef.current?.zoomToFit(0, 60);
                }
              }}
              onNodeClick={(node: unknown) => setSelected(node as GraphNode)}
            />
          )}
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
              no connected files at this commit
            </div>
          )}
        </div>

        {nodes.length > 0 && (
          <div className="absolute right-2.5 top-2.5 flex flex-col gap-1">
            <button
              onClick={zoomIn}
              title="zoom in"
              aria-label="zoom in"
              className="w-7 h-7 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 text-sm leading-none"
            >
              +
            </button>
            <button
              onClick={zoomOut}
              title="zoom out"
              aria-label="zoom out"
              className="w-7 h-7 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 text-sm leading-none"
            >
              −
            </button>
            <button
              onClick={zoomFit}
              title="reset view"
              aria-label="reset view"
              className="w-7 h-7 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 text-xs leading-none"
            >
              ⤢
            </button>
          </div>
        )}

        {selected && (
          <div className="absolute bottom-3 left-3 right-3 sm:right-auto sm:max-w-sm rounded-lg border border-slate-700 bg-slate-900/95 p-4 shadow-xl backdrop-blur z-10">
            <div className="flex items-start justify-between gap-2">
              <p className="font-mono text-[13px] text-slate-100 break-all">
                {selected.path}
              </p>
              <button
                onClick={() => setSelected(null)}
                className="text-slate-500 hover:text-slate-200 text-sm leading-none"
                aria-label="close"
              >
                ×
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                complexity {selected.complexity_score}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                {selected.loc} LOC
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                {selected.import_count} imports
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                {selected.function_count} funcs
              </span>
              {onboardingRank.has(selected.path) && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                  onboarding rank #{onboardingRank.get(selected.path)}
                </span>
              )}
            </div>
            {flags.has(selected.path) && (
              <p className="mt-2 text-xs text-amber-300/90">
                Flagged:{" "}
                {flags.get(selected.path) === "spike"
                  ? "appears in a flagged complexity/coupling spike"
                  : `${flags.get(selected.path)} ownership-decay risk`}
              </p>
            )}
          </div>
        )}
      </div>

      {isolated.length > 0 && (
        <div className="border-t border-slate-800 px-4 py-2.5">
          <button
            onClick={() => setShowIsolated((s) => !s)}
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            {isolated.length} isolated file{isolated.length === 1 ? "" : "s"}{" "}
            (no dependency edges) — {showIsolated ? "hide" : "show"}
          </button>
          {showIsolated && (
            <ul className="mt-2 max-h-32 overflow-y-auto space-y-1 pr-1">
              {isolated.slice(0, 40).map((n) => (
                <li
                  key={n.path}
                  className="font-mono text-[11px] text-slate-500 truncate"
                  title={n.path}
                >
                  {n.path}
                </li>
              ))}
              {isolated.length > 40 && (
                <li className="text-[11px] text-slate-600">…{isolated.length - 40} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
