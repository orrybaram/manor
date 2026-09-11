import type { PrInfo } from "./pr-info";

/**
 * ADR-167: the PR badge answers exactly one question — "can this ship?".
 * Evaluated in order; the first match wins.
 */
export type PrReadiness =
  | "ready"
  | "blocked"
  | "queued"
  | "pending"
  | "merged"
  | "closed";

export function prReadiness(pr: PrInfo): PrReadiness {
  if (pr.state === "merged") {
    return "merged";
  }
  if (pr.state === "closed") {
    return "closed";
  }

  const isBlocked =
    (pr.checks != null && pr.checks.failing > 0) ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    (pr.unresolvedThreads != null && pr.unresolvedThreads > 0);
  if (isBlocked) {
    return "blocked";
  }

  // Auto-merge armed or sitting in the merge queue: GitHub will merge it the
  // moment the remaining requirements pass. Ranked below "blocked" because a
  // failing check keeps a queued PR from ever merging, and that still needs
  // a human.
  if (pr.queuedToMerge) {
    return "queued";
  }

  // `checks == null` is "this commit has no status checks at all", not "the
  // checks have not loaded" — a PrInfo only exists once `gh pr list` has
  // answered. A repo without CI therefore has nothing to wait for, and an
  // approved PR there is as shippable as one with a green board.
  const checksClear =
    pr.checks == null || (pr.checks.failing === 0 && pr.checks.pending === 0);

  const isReady =
    !pr.isDraft &&
    checksClear &&
    pr.reviewDecision === "APPROVED" &&
    !pr.unresolvedThreads;
  if (isReady) {
    return "ready";
  }

  return "pending";
}
