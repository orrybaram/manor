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

  const isReady =
    !pr.isDraft &&
    pr.checks != null &&
    pr.checks.failing === 0 &&
    pr.checks.pending === 0 &&
    pr.reviewDecision === "APPROVED" &&
    !pr.unresolvedThreads;
  if (isReady) {
    return "ready";
  }

  return "pending";
}
