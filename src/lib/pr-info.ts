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
  /**
   * Where the entry came from: a top-level issue comment, a submitted review,
   * or an inline review thread. Absent on `latestComment`, which predates the
   * distinction.
   */
  kind?: PrCommentKind;
  /** Reviews only: APPROVED | CHANGES_REQUESTED | COMMENTED. */
  reviewState?: string | null;
  /** Review threads only: the file the thread hangs off. */
  path?: string | null;
  /** Review threads only. */
  isResolved?: boolean;
}

export type PrCommentKind = "comment" | "review" | "thread";

export type PrCheckStatus = "passing" | "failing" | "pending";

/**
 * One entry of the status check rollup, named. The counts in `ChecksSummary`
 * answer "can this ship?"; this answers "what broke?" — so the popover can
 * name the failing job instead of saying "1 failing".
 */
export interface PrCheckRun {
  name: string;
  status: PrCheckStatus;
  /** The run's page on GitHub (or the status context's target). */
  url?: string | null;
  /** Workflow the check run belongs to; absent for plain status contexts. */
  workflow?: string | null;
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
  /**
   * Newest first, capped — comments, reviews and unresolved review threads
   * interleaved. What the PR popover lists.
   */
  recentComments?: PrComment[];
  /** Individual checks behind `checks`, failing first. */
  checkRuns?: PrCheckRun[];
}
