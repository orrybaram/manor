/**
 * Canonical shape for a pull request as surfaced to the UI. Shared across the
 * IPC boundary so the main-process fetcher (`electron/github.ts`), the renderer
 * store, and the `electronAPI` contract (`src/electron.d.ts`) cannot drift.
 */
export interface ChecksSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface PrInfo {
  number: number;
  state: string;
  title: string;
  url: string;
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  checks?: ChecksSummary | null;
  unresolvedThreads?: number;
  commentCount?: number;
}
