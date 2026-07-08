import type { PrInfo } from "../store/project-store";
import type { AppPreferences } from "../electron.d";
import { useToastStore } from "../store/toast-store";

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

/** Which preference gates each event kind. */
const PREF_FOR: Record<PrNotifyEventKind, keyof AppPreferences> = {
  comment: "notifyOnPrComment",
  approved: "notifyOnPrApproved",
  "changes-requested": "notifyOnPrChangesRequested",
  "checks-failed": "notifyOnPrChecksFailed",
};

/** Deliver a single event: in-app toast when focused, native notification otherwise. */
function notifyPrEvent(event: PrNotifyEvent, url: string): void {
  if (document.hasFocus()) {
    useToastStore.getState().addToast({
      id: `pr-${event.kind}-${url}`,
      message: event.title,
      detail: event.body,
      status:
        event.kind === "checks-failed" || event.kind === "changes-requested"
          ? "error"
          : "success",
      action: {
        label: "View PR",
        onClick: () => void window.electronAPI.shell.openExternal(url),
      },
    });
  } else {
    void window.electronAPI.notifications.show({
      title: event.title,
      body: event.body,
      url,
    });
  }
}

/**
 * Diff `prev`→`next`, then deliver a notification for each changed event whose
 * preference is enabled. No-op when `next` is null or nothing notable changed.
 */
export function deliverPrNotifications(
  prev: PrInfo | null | undefined,
  next: PrInfo | null | undefined,
  prefs: AppPreferences,
): void {
  if (!next) return;
  for (const event of diffPrEvents(prev, next)) {
    if (prefs[PREF_FOR[event.kind]]) notifyPrEvent(event, next.url);
  }
}
