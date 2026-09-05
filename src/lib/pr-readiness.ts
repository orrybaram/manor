import type { PrInfo } from "./pr-info";

/**
 * ADR-167: the PR badge answers exactly one question — "can this ship?".
 * Evaluated in order; the first match wins.
 */
export type PrReadiness = "ready" | "blocked" | "pending" | "merged" | "closed";

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
