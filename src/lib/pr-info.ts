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

/**
 * The most recent conversation entry on a pull request — an issue comment or
 * a submitted review, whichever landed last. What a "new comment"
 * notification is actually about (#177).
 */
export interface PrComment {
  /** GitHub login; empty when the author account is gone. */
  author: string;
  /** Raw markdown, exactly as GitHub holds it. Empty for a bodiless review. */
  body: string;
  /** Deep link to the comment itself, not the PR. */
  url: string;
  /** ISO timestamp. */
  createdAt: string;
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
  /** Null when the PR has no comments or reviews yet; absent when unknown. */
  latestComment?: PrComment | null;
}
