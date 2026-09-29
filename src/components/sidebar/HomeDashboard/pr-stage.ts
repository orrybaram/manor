import type { PrStage } from "../../../lib/home-dashboard-studio";

/**
 * How every dashboard section names and colours a PR stage (ADR-198 §2):
 * running checks yellow, waiting on reviewers dim, blocked red, ready green.
 * `short` is for tight spots such as the Open PRs tile legend.
 */
export const PR_STAGE: Record<PrStage, { label: string; short: string; color: string }> = {
  checks: { label: "Checks running", short: "Checks", color: "var(--yellow)" },
  review: { label: "In review", short: "Review", color: "var(--hd-fg-4)" },
  blocked: { label: "Blocked", short: "Blocked", color: "var(--red)" },
  ready: { label: "Ready", short: "Ready", color: "var(--green)" },
};
