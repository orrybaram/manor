import type { PrInfo } from "./pr-info";

/**
 * ADR-167: the PR badge answers exactly one question — "can this ship?".
 * Evaluated in order: merged → closed → blocked → queued → review → ready →
 * pending. The first match wins.
 */
export type PrReadiness =
  | "ready"
  | "blocked"
  | "queued"
  | "review"
  | "pending"
  | "merged"
  | "closed";

/** ADR-198 §2: the pipeline column an open PR sits in. */
export type PrStage = "checks" | "review" | "blocked" | "ready";
export const PR_STAGES: readonly PrStage[] = ["checks", "review", "blocked", "ready"];

/** The first thing keeping a PR from merging, with what a surface needs to name it. */
export type PrBlocker =
  | { kind: "conflicts" }
  | {
      kind: "checks";
      /** Named failing runs; may be fewer than `failingCount`. */
      failing: { name: string; url: string | null }[];
      failingCount: number;
      passing: number;
      total: number;
    }
  | { kind: "changes-requested" }
  | { kind: "threads"; count: number };

/** ADR-202 §1: readiness, pipeline stage and blocker, from one walk of the order. */
export type PrVerdict =
  | { readiness: "blocked"; stage: "blocked"; blocker: PrBlocker }
  | { readiness: "merged" | "closed"; stage: null; blocker: null }
  | {
      readiness: "ready" | "queued" | "review" | "pending";
      stage: Exclude<PrStage, "blocked">;
      blocker: null;
    };

/**
 * ADR-202 §2: each blocker kind's Needs you card title and tone. Keyed by
 * kind, so a new blocker won't compile until it has both.
 */
export const PR_BLOCKER: Record<
  PrBlocker["kind"],
  { title: string; tone: "bad" | "warn" }
> = {
  conflicts: { title: "Conflicts", tone: "bad" },
  checks: { title: "Checks failing", tone: "bad" },
  "changes-requested": { title: "Changes requested", tone: "warn" },
  threads: { title: "Unresolved threads", tone: "warn" },
};

/** The inline reason for a blocked PR: "conflicts", "2 unresolved threads". */
export function blockerLabel(blocker: PrBlocker): string {
  switch (blocker.kind) {
    case "conflicts":
      return "conflicts";
    case "checks":
      return "checks failing";
    case "changes-requested":
      return "changes requested";
    case "threads":
      return `${blocker.count} unresolved thread${blocker.count === 1 ? "" : "s"}`;
  }
}

/** The first applicable blocker, in ADR-167 order; null when nothing blocks. */
function firstBlocker(pr: PrInfo): PrBlocker | null {
  if (pr.hasConflicts === true) return { kind: "conflicts" };
  if (pr.checks != null && pr.checks.failing > 0) {
    return {
      kind: "checks",
      failing: (pr.checkRuns ?? [])
        .filter((run) => run.status === "failing")
        .map((run) => ({ name: run.name, url: run.url ?? null })),
      failingCount: pr.checks.failing,
      passing: pr.checks.passing,
      total: pr.checks.total,
    };
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { kind: "changes-requested" };
  }
  if (pr.unresolvedThreads != null && pr.unresolvedThreads > 0) {
    return { kind: "threads", count: pr.unresolvedThreads };
  }
  return null;
}

/**
 * The one place the ADR-167 order lives: merged → closed → blocker
 * (conflicts → checks → changes requested → threads) → queued → review →
 * ready → pending.
 */
export function prVerdict(pr: PrInfo): PrVerdict {
  if (pr.state === "merged") {
    return { readiness: "merged", stage: null, blocker: null };
  }
  if (pr.state === "closed") {
    return { readiness: "closed", stage: null, blocker: null };
  }

  const blocker = firstBlocker(pr);
  if (blocker) {
    return { readiness: "blocked", stage: "blocked", blocker };
  }

  // Auto-merge armed or sitting in the merge queue: GitHub will merge it the
  // moment the remaining requirements pass. Ranked below "blocked" because a
  // failing check keeps a queued PR from ever merging, and that still needs
  // a human.
  if (pr.queuedToMerge) {
    return { readiness: "queued", stage: "ready", blocker: null };
  }

  // `checks == null` is "this commit has no status checks at all", not "the
  // checks have not loaded" — a PrInfo only exists once `gh pr list` has
  // answered. A repo without CI therefore has nothing to wait for, and an
  // approved PR there is as shippable as one with a green board.
  const checksClear =
    pr.checks == null || (pr.checks.failing === 0 && pr.checks.pending === 0);

  // GitHub reports "REVIEW_REQUIRED" specifically when the branch protection
  // rule wants a review nobody has cast yet — as opposed to `null`, which is
  // what a repo with no required review reports for every open PR. Only the
  // former is a real, nameable blocker worth its own badge state. (Unresolved
  // threads already returned as a blocker above.)
  if (!pr.isDraft && checksClear && pr.reviewDecision === "REVIEW_REQUIRED") {
    return { readiness: "review", stage: "review", blocker: null };
  }

  if (!pr.isDraft && checksClear && pr.reviewDecision === "APPROVED") {
    return { readiness: "ready", stage: "ready", blocker: null };
  }

  // Pending: running checks put it in the checks column; drafts and PRs
  // simply waiting on a reviewer sit in review.
  const checksRunning = pr.checks != null && pr.checks.pending > 0;
  return {
    readiness: "pending",
    stage: checksRunning ? "checks" : "review",
    blocker: null,
  };
}

/**
 * The readiness half of `prVerdict`. Kept for `openPrRows`; new code should
 * call `prVerdict`.
 */
export function prReadiness(pr: PrInfo): PrReadiness {
  return prVerdict(pr).readiness;
}
