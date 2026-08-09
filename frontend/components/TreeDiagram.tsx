"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { hierarchy, tree } from "d3-hierarchy";
import { baseColor, RING, type Flag } from "./graphEncoding";
import { computeStats, type FileNode, type TreeNode } from "./fileTreeModel";

interface Props {
  roots: TreeNode[];
  expanded: Set<string>;
  onToggle: (path: string) => void;
  flags: Map<string, Flag>;
  onboardingRank: Map<string, number>;
  repoName?: string;
  panZoom?: boolean;
}

// horizontal gap between adjacent siblings (fan-out room in the top-down layout)
const SIBLING_SPACING = 110;
// vertical gap between depth levels
const DEPTH_SPACING = 150;
const PAD = 40;
// extra layout room to the right so each level's labels stay inside bounds
const LABEL_ROOM = 110;
const MAX_R = 14;
// a node's label only renders once its circle is at least this many screen px
const MIN_LABEL_SCALE = 2.5;

interface LayNode {
  path: string;
  name: string;
  isDir: boolean;
  isRoot: boolean;
  px: number;
  py: number;
  r: number;
  fill: string;
  ring: Flag | null;
  dashed: boolean;
  rank: number | null;
  title: string;
}

interface LayLink {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

function leafRadius(cx: number): number {
  return Math.min(11, Math.max(3.5, 2 + Math.log1p(Math.max(1, cx || 1)) * 1.7));
}

function folderRadius(fileCount: number): number {
  return Math.min(MAX_R, 5 + Math.log1p(Math.max(1, fileCount)) * 1.6);
}

// CSS transform on SVG children only animates if it goes through the style
// property (transform-box: view-box keeps the origin at the SVG origin).
const animTransform = (x: number, y: number): CSSProperties => ({
  transform: `translate(${x}px, ${y}px)`,
  transformBox: "view-box",
  transformOrigin: "0px 0px",
  transition: "transform 400ms ease",
});

export default function TreeDiagram({
  roots,
  expanded,
  onToggle,
  flags,
  onboardingRank,
  repoName,
  panZoom = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 });
  const suppressClick = useRef(false);
  const pan = useRef<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stats = useMemo(() => computeStats(roots, flags), [roots, flags]);

  const layout = useMemo(() => {
    const rootData: TreeNode = {
      type: "dir",
      name: repoName || "Root",
      path: "",
      children: roots,
    };
    // only include the children of folders that are currently expanded
    const hRoot = hierarchy<TreeNode>(rootData, (d) =>
      d.type === "dir" && (d.path === "" || expanded.has(d.path))
        ? d.children
        : undefined,
    );
    tree<TreeNode>().nodeSize([SIBLING_SPACING, DEPTH_SPACING])(hRoot);

    let totalFiles = 0;
    let totalMaxCx = 0;
    for (const r of roots) {
      const s = stats.get(r.path);
      if (s) {
        totalFiles += s.fileCount;
        if (s.maxComplexity > totalMaxCx) totalMaxCx = s.maxComplexity;
      }
    }

    const nodes: LayNode[] = [];
    const links: LayLink[] = [];
    let minPx = Infinity;
    let maxPx = -Infinity;
    let minPy = Infinity;
    let maxPy = -Infinity;

    hRoot.each((d) => {
      const data = d.data;
      const isDir = data.type === "dir";
      const isRoot = d.depth === 0;
      const px = d.x!; // sibling spread along x (horizontal, top-down layout)
      const py = d.y!; // depth along y (vertical)
      let r: number;
      let fill: string;
      let ring: Flag | null = null;
      let rank: number | null = null;
      let title: string;
      if (isRoot) {
        r = folderRadius(totalFiles);
        fill = baseColor(totalMaxCx);
        title = `${data.name} · ${totalFiles} files · max complexity ${totalMaxCx}`;
      } else if (isDir) {
        const s = stats.get(data.path);
        const fc = s?.fileCount ?? 0;
        r = folderRadius(fc);
        fill = baseColor(s?.maxComplexity ?? 0);
        ring = s?.flag ?? null;
        title = `${data.path}/\n${fc} file${fc === 1 ? "" : "s"} · max complexity ${s?.maxComplexity ?? 0}${
          ring ? `\ncontains ${ring} risk` : ""
        }`;
      } else {
        const n = (data as FileNode).node;
        r = leafRadius(n.complexity_score);
        fill = baseColor(n.complexity_score);
        ring = flags.get(data.path) ?? null;
        rank = onboardingRank.get(data.path) ?? null;
        title = `${data.path}\ncomplexity ${n.complexity_score} · ${n.loc} LOC · ${n.import_count} imports${
          rank ? `\nonboarding rank #${rank}` : ""
        }`;
      }
      nodes.push({
        path: data.path,
        name: data.name,
        isDir,
        isRoot,
        px,
        py,
        r,
        fill,
        ring,
        dashed: isDir && !isRoot,
        rank,
        title,
      });
      minPx = Math.min(minPx, px);
      maxPx = Math.max(maxPx, px);
      minPy = Math.min(minPy, py);
      maxPy = Math.max(maxPy, py);
    });

    hRoot.links().forEach((l) => {
      links.push({
        sx: l.source.x!,
        sy: l.source.y!,
        tx: l.target.x!,
        ty: l.target.y!,
      });
    });

    const xMin = Math.min(minPx, 0) - PAD;
    const xMax = Math.max(maxPx, 0) + MAX_R + LABEL_ROOM;
    const yMin = minPy - MAX_R - PAD;
    const yMax = maxPy + MAX_R + PAD;
    const offX = -xMin;
    const offY = -yMin;
    for (const n of nodes) {
      n.px += offX;
      n.py += offY;
    }
    for (const l of links) {
      l.sx += offX;
      l.sy += offY;
      l.tx += offX;
      l.ty += offY;
    }
    return { nodes, links, w: xMax - xMin, h: yMax - yMin };
  }, [roots, expanded, stats, repoName, flags, onboardingRank]);

  const fit = useMemo(() => {
    if (!size.w || !size.h) return { x: 0, y: 0, k: 1 };
    const k = Math.min(size.w / layout.w, size.h / layout.h, 1);
    return { x: (size.w - layout.w * k) / 2, y: (size.h - layout.h * k) / 2, k };
  }, [size, layout]);

  const transform = panZoom ? tf : fit;

  // in pan/zoom mode, re-fit whenever the visible layout changes (collapse/expand);
  // adjusting state during render is the React-recommended way to reset derived state.
  const [prevFit, setPrevFit] = useState(fit);
  if (panZoom && prevFit !== fit) {
    setPrevFit(fit);
    setTf(fit);
  }

  useEffect(() => {
    if (!panZoom) return;
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setTf((t) => {
        const k = Math.min(4, Math.max(0.04, t.k * Math.exp(-e.deltaY * 0.0012)));
        const wx = (mx - t.x) / t.k;
        const wy = (my - t.y) / t.k;
        return { k, x: mx - wx * k, y: my - wy * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [panZoom]);

  useEffect(() => {
    if (!panZoom) return;
    const move = (e: PointerEvent) => {
      const p = pan.current;
      if (!p) return;
      const dx = e.clientX - p.sx;
      const dy = e.clientY - p.sy;
      if (!p.moved && Math.hypot(dx, dy) > 3) p.moved = true;
      if (p.moved) setTf((t) => ({ ...t, x: p.ox + dx, y: p.oy + dy }));
    };
    const up = () => {
      suppressClick.current = pan.current?.moved ?? false;
      pan.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [panZoom]);

  const zoomBy = (f: number) => {
    setTf((t) => {
      const k = Math.min(4, Math.max(0.04, t.k * f));
      return { k, x: size.w / 2 - ((size.w / 2 - t.x) * k) / t.k, y: size.h / 2 - ((size.h / 2 - t.y) * k) / t.k };
    });
  };

  const onNodeClick = (path: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    onToggle(path);
  };

  const scale = transform.k;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none"
      style={{ touchAction: "none" }}
    >
      <style>{`
        .treenode { cursor: default; }
        .treenode[data-dir="true"] { cursor: pointer; }
        .treenode:hover circle.face { stroke: #67e8f9; stroke-width: 2; }
      `}</style>
      {size.w > 0 && (
        <svg
          width={size.w}
          height={size.h}
          className="block"
          onPointerDown={
            panZoom
              ? (e) => {
                  pan.current = { sx: e.clientX, sy: e.clientY, ox: tf.x, oy: tf.y, moved: false };
                }
              : undefined
          }
        >
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {layout.links.map((l, i) => {
              const dx = l.tx - l.sx;
              const dy = l.ty - l.sy;
              return (
                <g
                  key={`l-${i}`}
                  data-link={`${l.sx},${l.sy},${l.tx},${l.ty}`}
                  style={animTransform(l.sx, l.sy)}
                >
                  <path
                    d={`M0,0 C0,${dy / 2} ${dx},${dy / 2} ${dx},${dy}`}
                    fill="none"
                    stroke="#334155"
                    strokeWidth={1.5}
                  />
                </g>
              );
            })}
            {layout.nodes.map((n) => (
              <g
                key={n.path || "root"}
                className="treenode"
                data-dir={n.isDir && !n.isRoot}
                data-node={n.path}
                style={animTransform(n.px, n.py)}
                onClick={n.isDir && !n.isRoot ? () => onNodeClick(n.path) : undefined}
              >
                <title>{n.title}</title>
                {n.dashed && (
                  <circle
                    r={n.r + 5}
                    fill="none"
                    stroke="#475569"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                )}
                {n.ring && (
                  <circle
                    r={n.r + 2.5}
                    fill="none"
                    stroke={RING[n.ring]}
                    strokeWidth={1.6}
                    opacity={0.9}
                  />
                )}
                <circle
                  r={n.r}
                  fill={n.fill}
                  stroke="#0f172a"
                  strokeWidth={1}
                  className="face"
                />
                {n.rank != null && (
                  <text
                    x={-n.r - 3}
                    dy="0.35em"
                    textAnchor="end"
                    style={{ fontSize: 9 / scale, fill: "#34d399", pointerEvents: "none" }}
                  >
                    #{n.rank}
                  </text>
                )}
                {n.r * scale >= MIN_LABEL_SCALE && (
                  <text
                    x={n.r + 5}
                    dy="0.35em"
                    style={{ fontSize: 11 / scale, fill: "#cbd5e1", pointerEvents: "none" }}
                  >
                    {n.name}
                    {n.isDir ? "/" : ""}
                  </text>
                )}
              </g>
            ))}
          </g>
        </svg>
      )}

      {panZoom && (
        <div className="absolute right-3 bottom-3 flex flex-col gap-1">
          <button
            onClick={() => zoomBy(1.4)}
            aria-label="zoom in"
            className="w-8 h-8 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 text-base leading-none"
          >
            +
          </button>
          <button
            onClick={() => zoomBy(1 / 1.4)}
            aria-label="zoom out"
            className="w-8 h-8 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 text-base leading-none"
          >
            −
          </button>
          <button
            onClick={() => setTf(fit)}
            aria-label="reset view"
            className="w-8 h-8 rounded bg-slate-900/90 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/50 text-xs leading-none"
          >
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}
