import type { GraphNode } from "@/lib/api";
import type { Flag } from "./graphEncoding";

export interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  type: "file";
  name: string;
  path: string;
  node: GraphNode;
}

export type TreeNode = DirNode | FileNode;

const sortChildren = (arr: TreeNode[]) =>
  arr.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

/** Build a nested directory tree from repo-relative file paths (deterministic: dirs first, then alphabetical). */
export function buildTree(nodes: GraphNode[]): TreeNode[] {
  const root: DirNode = { type: "dir", name: "", path: "", children: [] };
  const seen = new Set<string>();
  for (const n of nodes) {
    const parts = n.path.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        if (seen.has(p)) return;
        seen.add(p);
        cur.children.push({ type: "file", name: part, path: p, node: n });
      } else {
        let dir = cur.children.find(
          (c): c is DirNode => c.type === "dir" && c.name === part,
        );
        if (!dir) {
          dir = { type: "dir", name: part, path: p, children: [] };
          cur.children.push(dir);
        }
        cur = dir;
      }
    });
  }
  sortChildren(root.children);
  return root.children;
}

export function collectDirPaths(roots: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === "dir") {
        out.push(n.path);
        walk(n.children);
      }
    }
  };
  walk(roots);
  return out;
}

export function topLevelDirPaths(roots: TreeNode[]): string[] {
  return roots.filter((n) => n.type === "dir").map((n) => n.path);
}

export function countFiles(node: TreeNode): number {
  if (node.type === "file") return 1;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

export interface FolderStats {
  fileCount: number;
  maxComplexity: number;
  flag: Flag | null;
}

const FLAG_PRIORITY: Record<Flag, number> = { high: 3, spike: 2, medium: 1 };

/** Aggregate per-node stats: for folders, total file count, max descendant complexity, and highest-priority descendant flag. */
export function computeStats(
  roots: TreeNode[],
  flags: Map<string, Flag>,
): Map<string, FolderStats> {
  const out = new Map<string, FolderStats>();
  const walk = (node: TreeNode): FolderStats => {
    if (node.type === "file") {
      const st: FolderStats = {
        fileCount: 1,
        maxComplexity: node.node.complexity_score || 0,
        flag: flags.get(node.path) ?? null,
      };
      out.set(node.path, st);
      return st;
    }
    let fileCount = 0;
    let maxComplexity = 0;
    let flag: Flag | null = null;
    let priority = 0;
    for (const c of node.children) {
      const s = walk(c);
      fileCount += s.fileCount;
      if (s.maxComplexity > maxComplexity) maxComplexity = s.maxComplexity;
      if (s.flag && FLAG_PRIORITY[s.flag] > priority) {
        flag = s.flag;
        priority = FLAG_PRIORITY[s.flag];
      }
    }
    const st: FolderStats = { fileCount, maxComplexity, flag };
    out.set(node.path, st);
    return st;
  };
  for (const r of roots) walk(r);
  return out;
}
