import type { PrComment, PrInfo } from "../lib/pr-info";
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
  /** `comment` events only: what was said, when the fetcher knows (#177). */
  comment?: PrComment;
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
    const event: PrNotifyEvent = {
      kind: "comment",
      title: `PR #${n} — new comment`,
      body,
    };
    if (next.latestComment) event.comment = next.latestComment;
    events.push(event);
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

/**
 * Does this comment's author earn a notification? Bots (`github-actions`,
 * Dependabot, CI reporters) and your own comments are both noise by default —
 * you already know what you said, and automation says a great deal.
 *
 * An unknown author (a payload written before the fetcher tagged authors)
 * passes: better a stray notification than a silently dropped one.
 */
export function commentPassesFilters(
  comment: PrComment | undefined,
  prefs: AppPreferences,
): boolean {
  if (!comment) return true;
  if (comment.isBot && !prefs.notifyOnBotPrComments) return false;
  if (comment.isViewer && !prefs.notifyOnOwnPrComments) return false;
  return true;
}

/**
 * Everything said since the baseline's newest entry, newest first.
 *
 * `latestComment` alone is not enough to filter on: one poll interval can
 * cover a bot comment *and* a human one, and the bot landing last must not
 * silence the human. With no usable baseline timestamp the whole pool is
 * considered, and an empty pool falls back to `latestComment` so the
 * count-based event still has something to be judged on.
 */
function commentsSince(prev: PrInfo, next: PrInfo): PrComment[] {
  const latest = next.latestComment ?? undefined;
  const pool = [...(next.recentComments ?? [])];
  if (latest && !pool.some((c) => c.url === latest.url)) pool.push(latest);

  const since = prev.latestComment
    ? Date.parse(prev.latestComment.createdAt)
    : NaN;
  const fresh = Number.isFinite(since)
    ? pool.filter((c) => Date.parse(c.createdAt) > since)
    : pool;

  if (fresh.length === 0) return latest ? [latest] : [];
  return fresh.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Which preference gates each event kind. */
const PREF_FOR: Record<PrNotifyEventKind, keyof AppPreferences> = {
  comment: "notifyOnPrComment",
  approved: "notifyOnPrApproved",
  "changes-requested": "notifyOnPrChangesRequested",
  "checks-failed": "notifyOnPrChecksFailed",
};

/**
 * Deliver a single event: native notification when unfocused, in-app toast
 * otherwise.
 *
 * Main decides which, because the renderer cannot see its own focus reliably:
 * `document.hasFocus()` is false whenever a `<webview>` pane holds focus, but
 * `win.isFocused()` is true — so gating the toast here and gating the native
 * notification in main dropped the event on the floor whenever a browser pane
 * (or a detached window) had focus. `notifications.show` returns whether it
 * presented; a `false` means "this window is focused, you toast it".
 */
async function notifyPrEvent(
  event: PrNotifyEvent,
  url: string,
): Promise<void> {
  const shown = await window.electronAPI.notifications.show({
    kind: event.kind,
    title: event.title,
    body: event.body,
    url,
    comment: event.comment,
  });
  if (shown) return;

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
    if (!prefs[PREF_FOR[event.kind]]) continue;
    if (event.kind === "comment" && event.comment && prev) {
      // Notify about the newest comment that survives the author filters —
      // not necessarily the newest comment outright.
      const comment = commentsSince(prev, next).find((c) =>
        commentPassesFilters(c, prefs),
      );
      if (!comment) continue;
      event.comment = comment;
    }
    // A comment notification leads to the comment, not the top of the PR.
    void notifyPrEvent(event, event.comment?.url ?? next.url);
  }
}
