import type { PrStage } from "../../../lib/pr-readiness";

/**
 * How every dashboard section names and colours a PR stage:
 * running checks yellow, waiting on reviewers cyan, blocked red, ready green.
 * `short` is for tight spots such as the rail's Open PRs legend ("1 CI").
 */
export const PR_STAGE: Record<PrStage, { label: string; short: string; color: string }> = {
  checks: { label: "Checks running", short: "CI", color: "var(--yellow)" },
  review: { label: "In review", short: "Review", color: "var(--cyan)" },
  blocked: { label: "Blocked", short: "Blocked", color: "var(--red)" },
  ready: { label: "Ready", short: "Ready", color: "var(--green)" },
};
