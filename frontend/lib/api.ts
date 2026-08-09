export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export interface AnalyzeResult {
  jobId: string;
  cached: boolean;
}

export interface Progress {
  stage: string;
  message: string;
  percent: number;
}

export interface JobStatus {
  jobId: string;
  repoId: string;
  url: string;
  status: "queued" | "running" | "done" | "failed";
  progress: Progress | null;
  total_commits: number | null;
  sampled_commit_count: number | null;
  default_branch: string | null;
  error_message: string | null;
}

export interface Spike {
  id: string;
  metric: "complexity" | "coupling";
  delta: number;
  gap_commits: number;
  commit_range: [string, string];
  affected_files: string[];
  reason: string;
}

export interface DecayItem {
  path: string;
  former_primary_owner: string;
  owner_commit_share: number;
  inactive_duration_days: number;
  risk_level: "low" | "medium" | "high";
  last_active_commit_date: string;
}

export interface OnboardingFile {
  path: string;
  rank: number;
  reason: string;
  complexity_score: number;
  loc: number;
  indegree: number;
  final_rank_score?: number;
  ai_classified?: boolean;
  ai_category?: string | null;
  ai_importance?: number | null;
  ai_reason?: string | null;
}

export interface AiRankingInfo {
  enabled: boolean;
  model: string;
  shortlist_count: number;
  classified_count: number;
  fallback_count: number;
  duration_ms: number;
  max_concurrent?: number;
  rate_limit_rpm?: number;
  retries?: number;
  quota_exhausted?: boolean;
  billing_failed?: boolean;
  quota_hits?: number;
  blended: boolean;
}

export interface SeriesPoint {
  commit_sha: string;
  commit_date: string;
  avg_complexity: number;
  total_complexity: number;
  total_edges: number;
  total_files: number;
}

export interface Report {
  repo: {
    id: string;
    url: string;
    default_branch: string | null;
    total_commits: number;
    sampled_commit_count: number;
    last_analyzed_at: string;
  };
  sampling: { message: string };
  spikes: Spike[];
  decay: { active: DecayItem[]; historical: DecayItem[] };
  onboarding: {
    ordered_files: OnboardingFile[];
    generated_from_commit: string;
    ai_ranking?: AiRankingInfo | null;
  };
  series: SeriesPoint[];
}

export interface GraphNode {
  id: string;
  path: string;
  complexity_score: number;
  loc: number;
  import_count: number;
  function_count: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  commit_sha: string;
  commit_date: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function createAnalysis(
  repoUrl: string,
  opts?: { force?: boolean },
): Promise<AnalyzeResult> {
  return fetch(`${API_URL}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl, force: opts?.force ?? false }),
  }).then((r) => handle<AnalyzeResult>(r));
}

export function getStatus(jobId: string): Promise<JobStatus> {
  return fetch(`${API_URL}/api/analyze/${jobId}/status`).then((r) =>
    handle<JobStatus>(r),
  );
}

export function getReport(repoId: string): Promise<Report> {
  return fetch(`${API_URL}/api/repos/${repoId}/report`).then((r) =>
    handle<Report>(r),
  );
}

export function getGraph(repoId: string, commitSha?: string): Promise<GraphData> {
  const q = commitSha
    ? `?commitSha=${encodeURIComponent(commitSha)}`
    : "";
  return fetch(`${API_URL}/api/repos/${repoId}/graph${q}`).then((r) =>
    handle<GraphData>(r),
  );
}
