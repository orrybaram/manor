/**
 * Pure selectors for the full Home dashboard ("Studio") — the PR
 * table, Needs you cards and the rail's Open PRs numbers. Like
 * `home-dashboard.ts` (whose helpers these build on) there are no store or
 * React imports: the components wire store state in.
 */

import type {
  DiffStats,
  ProjectInfo,
  WorkspaceInfo,
} from "../store/project-store";
import { prVerdict, type PrBlocker, type PrStage } from "./pr-readiness";
import type { PrInfo } from "./pr-info";
import {
  itemKey,
  needsYouItems,
  type NeedsYouInput,
  type NeedsYouItem,
} from "./home-dashboard";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from `iso` to `now` (never negative), or null when `iso` is absent or unparseable. */
function ageSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, now - at);
}

// ── Pull requests table ──

/** The CI cell: the commit's status checks, summed up. */
export type CiSignal =
  | { kind: "none" }
  | { kind: "passing"; total: number }
  | { kind: "running"; done: number; total: number }
  | {
      kind: "failing";
      count: number;
      /** Named failing runs; may be fewer than `count`. */
      names: string[];
      total: number;
    };

/** The Review cell: where the PR's review stands. */
export type ReviewSignal =
  | { kind: "draft" }
  | { kind: "approved" }
  | { kind: "changes-requested" }
  /** Waiting, with the human reviewers known: how many of them approved. */
  | { kind: "reviewers"; approved: number; total: number }
  /** Waiting, nobody named. */
  | { kind: "waiting" };

/**
 * The Merge cell: can the branch merge, or is it already on its way.
 * "unknown" when GitHub didn't say whether it conflicts.
 */
export type MergeSignal = "clean" | "conflicts" | "queued" | "unknown";

export interface PrTableRow {
  pr: PrInfo;
  project: ProjectInfo;
  workspace: WorkspaceInfo;
  stage: PrStage;
  /** Lines added and removed; null when GitHub didn't report them. */
  size: { additions: number; deletions: number } | null;
  ci: CiSignal;
  review: ReviewSignal;
  /** Unresolved review threads. */
  threads: number;
  merge: MergeSignal;
  /** Time since `pr.updatedAt`; null when GitHub didn't report it. */
  ageMs: number | null;
  /** No activity for a day or more. */
  stale: boolean;
}

/** The table's stage order: what needs the user first. */
const TABLE_STAGE_ORDER: readonly PrStage[] = ["blocked", "ready", "checks", "review"];

function ciSignal(pr: PrInfo): CiSignal {
  const checks = pr.checks;
  if (!checks || checks.total === 0) return { kind: "none" };
  if (checks.failing > 0) {
    return {
      kind: "failing",
      count: checks.failing,
      names: (pr.checkRuns ?? [])
        .filter((run) => run.status === "failing")
        .map((run) => run.name),
      total: checks.total,
    };
  }
  if (checks.pending > 0) {
    return {
      kind: "running",
      done: checks.total - checks.pending,
      total: checks.total,
    };
  }
  return { kind: "passing", total: checks.total };
}

function reviewSignal(pr: PrInfo): ReviewSignal {
  if (pr.isDraft) return { kind: "draft" };
  if (pr.reviewDecision === "APPROVED") return { kind: "approved" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { kind: "changes-requested" };
  }
  // Bots (Copilot and the like) comment but don't gate the merge.
  const people = (pr.reviewers ?? []).filter((r) => !r.isBot);
  const approved = people.filter((r) => r.state === "approved").length;
  // A repo without required reviews never reports APPROVED: everyone asked
  // having approved is as good as it gets.
  if (people.length > 0 && approved === people.length) {
    return { kind: "approved" };
  }
  if (people.length > 0) {
    return {
      kind: "reviewers",
      approved,
      total: people.length,
    };
  }
  return { kind: "waiting" };
}

function mergeSignal(pr: PrInfo): MergeSignal {
  if (pr.hasConflicts === true) return "conflicts";
  if (pr.queuedToMerge) return "queued";
  return pr.hasConflicts === false ? "clean" : "unknown";
}

/**
 * Every open PR across `projects` (deduped by `pr.url`, first wins), one row
 * each with its `prVerdict` stage and signal cells. Rows run blocked → ready
 * → checks → review, drafts after everything else; within a group the oldest
 * `updatedAt` comes first and PRs of unknown age go last in `projects` then
 * workspace order.
 */
export function prTable(
  projects: readonly ProjectInfo[],
  now: number,
): PrTableRow[] {
  const rows: PrTableRow[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    for (const workspace of project.workspaces) {
      const pr = workspace.pr;
      if (!pr || pr.state !== "open") continue;
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      const verdict = prVerdict(pr);
      // An open PR always has a stage; this narrows away the merged/closed arm.
      if (verdict.stage == null) continue;
      const ageMs = ageSince(pr.updatedAt, now);
      rows.push({
        pr,
        project,
        workspace,
        stage: verdict.stage,
        size:
          pr.additions != null || pr.deletions != null
            ? { additions: pr.additions ?? 0, deletions: pr.deletions ?? 0 }
            : null,
        ci: ciSignal(pr),
        review: reviewSignal(pr),
        threads: pr.unresolvedThreads ?? 0,
        merge: mergeSignal(pr),
        ageMs,
        stale: ageMs != null && ageMs >= DAY_MS,
      });
    }
  }
  const group = (row: PrTableRow) =>
    (row.pr.isDraft ? TABLE_STAGE_ORDER.length : 0) +
    TABLE_STAGE_ORDER.indexOf(row.stage);
  // Stable sort: unknown ages tie with each other and keep insertion order.
  return rows.sort((a, b) => {
    const byGroup = group(a) - group(b);
    if (byGroup !== 0) return byGroup;
    if (a.ageMs == null || b.ageMs == null) {
      return (a.ageMs == null ? 1 : 0) - (b.ageMs == null ? 1 : 0);
    }
    return b.ageMs - a.ageMs;
  });
}

export interface OpenPrStats {
  total: number;
  /** The oldest known PR age; null when no PR has one. */
  oldestAgeMs: number | null;
  byStage: Record<PrStage, number>;
}

/** The Open PRs summary: count, oldest age and the stacked stage bar. */
export function openPrStats(rows: readonly PrTableRow[]): OpenPrStats {
  const byStage: Record<PrStage, number> = {
    checks: 0,
    review: 0,
    blocked: 0,
    ready: 0,
  };
  let oldestAgeMs: number | null = null;
  for (const row of rows) {
    byStage[row.stage] += 1;
    if (row.ageMs != null && (oldestAgeMs == null || row.ageMs > oldestAgeMs)) {
      oldestAgeMs = row.ageMs;
    }
  }
  return { total: rows.length, oldestAgeMs, byStage };
}

// ── Needs you cards ──

/** The first unresolved review thread's comment, for a threads row's context. */
export interface ThreadSnippet {
  /** GitHub login; empty when the author account is gone. */
  author: string;
  /** The comment's text on one line, whitespace collapsed. */
  snippet: string;
  url: string;
}

/** Why a Needs you row needs the user: what its context column says. */
export type NeedsYouCardContext =
  | { kind: "input"; paneTitle?: string }
  | { kind: "error"; paneTitle?: string }
  | Exclude<PrBlocker, { kind: "threads" }>
  | (Extract<PrBlocker, { kind: "threads" }> & { comment?: ThreadSnippet })
  | { kind: "finished"; diff?: DiffStats }
  | {
      kind: "ready";
      approved: boolean;
      checksPassing: number;
      checksTotal: number;
    };

export type NeedsYouCard = NeedsYouItem & {
  /** `itemKey(item)` — the React key and the snooze key. */
  key: string;
  context: NeedsYouCardContext;
  /** How long the item has waited: since the agent's last update, or the PR's `updatedAt`. */
  ageMs: number | null;
};

export interface NeedsYouCardsInput extends NeedsYouInput {
  /** Live pane titles, for a waiting or errored agent's row. */
  paneTitle?: Readonly<Record<string, string>>;
  /** Item keys the user snoozed; those cards are dropped. */
  snoozed?: ReadonlySet<string>;
}

/**
 * The first unresolved review thread in `pr.recentComments` (newest first),
 * else `pr.latestComment` when it is one; null when neither says.
 */
function firstUnresolvedThread(pr: PrInfo): ThreadSnippet | null {
  const comment =
    pr.recentComments?.find((c) => c.kind === "thread" && c.isResolved === false) ??
    (pr.latestComment?.isResolved === false ? pr.latestComment : null);
  if (!comment) return null;
  const snippet = comment.body.replace(/\s+/g, " ").trim();
  if (!snippet) return null;
  return { author: comment.author, snippet, url: comment.url };
}

function cardContext(
  item: NeedsYouItem,
  input: NeedsYouCardsInput,
): NeedsYouCardContext {
  if (item.kind === "pr") {
    if (item.blocker?.kind === "threads") {
      const comment = firstUnresolvedThread(item.pr);
      return comment ? { ...item.blocker, comment } : item.blocker;
    }
    if (item.blocker) return item.blocker;
    return {
      kind: "ready",
      approved: item.pr.reviewDecision === "APPROVED",
      checksPassing: item.pr.checks?.passing ?? 0,
      checksTotal: item.pr.checks?.total ?? 0,
    };
  }
  switch (item.tier) {
    case "input":
    case "error": {
      const paneTitle = item.agent.paneId
        ? input.paneTitle?.[item.agent.paneId]
        : undefined;
      return paneTitle ? { kind: item.tier, paneTitle } : { kind: item.tier };
    }
    case "finished": {
      const diff = item.workspace?.diffStats;
      return diff
        ? {
            kind: "finished",
            diff: { added: diff.added, removed: diff.removed },
          }
        : { kind: "finished" };
    }
  }
}

/**
 * `needsYouItems` (same tier order) as Needs you rows with their context
 * (why each needs the user) and age, minus anything in `input.snoozed`.
 */
export function needsYouCards(
  input: NeedsYouCardsInput,
  now: number,
): NeedsYouCard[] {
  const cards: NeedsYouCard[] = [];
  for (const item of needsYouItems(input)) {
    const key = itemKey(item);
    if (input.snoozed?.has(key)) continue;
    cards.push({
      ...item,
      key,
      context: cardContext(item, input),
      ageMs:
        item.kind === "agent"
          ? ageSince(item.agent.updatedAt, now)
          : ageSince(item.pr.updatedAt, now),
    });
  }
  return cards;
}
