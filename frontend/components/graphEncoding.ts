export type Flag = "high" | "medium" | "spike";

export function baseColor(cx: number): string {
  if (cx >= 30) return "#8b5cf6"; // violet - dense
  if (cx >= 15) return "#6366f1"; // indigo
  if (cx >= 6) return "#334155";  // slate-700
  return "#1e293b";               // slate-800
}

export const RING: Record<Flag, string> = {
  high: "#f87171",
  medium: "#fbbf24",
  spike: "#c084fc",
};

/** leaf-node dot radius in the file tree, scaled with complexity (smaller than force-graph circles) */
export function dotRadius(cx: number): number {
  return Math.min(8, 2 + Math.log1p(Math.max(1, cx || 1)) * 1.3);
}
