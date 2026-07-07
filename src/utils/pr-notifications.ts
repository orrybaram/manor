import type { PrInfo } from "../store/project-store";

export type PrNotifyEventKind =
  | "comment"
  | "approved"
  | "changes-requested"
  | "checks-failed";

export interface PrNotifyEvent {
  kind: PrNotifyEventKind;
  title: string; // e.g. "PR #123 approved"
  body: string; // the PR title
}

/**
 * Compute the notification events triggered by a transition from `prev` to
 * `next` PR state. Returns `[]` when there is no baseline (either side is
 * null/undefined) so app boot and first-sight PRs stay silent.
 */
export function diffPrEvents(
  prev: PrInfo | null | undefined,
  next: PrInfo | null | undefined,
): PrNotifyEvent[] {
  if (!prev || !next) return [];

  const events: PrNotifyEvent[] = [];
  const n = next.number;
  const body = next.title;

  if (
    typeof next.commentCount === "number" &&
    typeof prev.commentCount === "number" &&
    next.commentCount > prev.commentCount
  ) {
    events.push({ kind: "comment", title: `PR #${n} — new comment`, body });
  }

  if (
    next.reviewDecision === "APPROVED" &&
    prev.reviewDecision !== "APPROVED"
  ) {
    events.push({ kind: "approved", title: `PR #${n} approved`, body });
  }

  if (
    next.reviewDecision === "CHANGES_REQUESTED" &&
    prev.reviewDecision !== "CHANGES_REQUESTED"
  ) {
    events.push({
      kind: "changes-requested",
      title: `PR #${n} — changes requested`,
      body,
    });
  }

  if ((next.checks?.failing ?? 0) > 0 && (prev.checks?.failing ?? 0) === 0) {
    events.push({
      kind: "checks-failed",
      title: `PR #${n} — CI checks failing`,
      body,
    });
  }

  return events;
}
