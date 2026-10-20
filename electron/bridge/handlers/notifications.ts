import { assertString } from "../../ipc-validate";
import type { PrNotifyEventKind } from "../../notifications";
import type { PrComment } from "../../../src/lib/pr-info";
import type { NotificationRecord } from "../../notification-store";
import type { ServerDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";

/**
 * The durable notification log. Main owns the
 * list; the renderer keeps a cache of it and never mutates its copy
 * speculatively — every mutation re-broadcasts the whole list through the
 * single send-site in `../../notifications`.
 */
export function notificationsGetAll(
  ctx: HandlerCtx<ServerDeps>,
): NotificationRecord[] {
  return ctx.deps.notificationStore.getAll();
}

/**
 * Whether anything changed: `markRead` is false for an id that is unknown *or*
 * already read, and only a real transition is worth a broadcast.
 */
export function notificationsMarkRead(
  ctx: HandlerCtx<ServerDeps>,
  id: string,
): boolean {
  assertString(id, "id");
  const changed = ctx.deps.notificationStore.markRead(id);
  if (changed) ctx.deps.notifier.sendNotificationsUpdate();
  return changed;
}

export function notificationsMarkAllRead(ctx: HandlerCtx<ServerDeps>): void {
  ctx.deps.notificationStore.markAllRead();
  ctx.deps.notifier.sendNotificationsUpdate();
}

export function notificationsClear(ctx: HandlerCtx<ServerDeps>): void {
  ctx.deps.notificationStore.clear();
  ctx.deps.notifier.sendNotificationsUpdate();
}

/**
 * Show a native notification on demand (e.g. a PR update alert).
 * Resolves whether it was presented — `false` means the calling window is
 * focused, and the caller should show an in-app toast instead; see
 * `presentNotification` in `../../notifications`.
 */
export function notificationsShow(
  ctx: HandlerCtx<ServerDeps>,
  payload: {
    kind: PrNotifyEventKind;
    title: string;
    body: string;
    url?: string;
    comment?: PrComment;
  },
): boolean {
  assertString(payload.title, "title");
  assertString(payload.body, "body");
  if (payload.comment !== undefined) {
    assertString(payload.comment.author, "comment.author");
    assertString(payload.comment.body, "comment.body");
    assertString(payload.comment.url, "comment.url");
    assertString(payload.comment.createdAt, "comment.createdAt");
  }
  // No notifier to focus-check for means nothing was presented: the caller
  // toasts.
  return ctx.deps.notifier.showPrNotification?.(payload, ctx.caller) ?? false;
}

export const notifications = {
  getAll: method(notificationsGetAll),
  markRead: method(notificationsMarkRead, { mutating: true }),
  markAllRead: method(notificationsMarkAllRead, { mutating: true }),
  clear: method(notificationsClear, { mutating: true }),
  show: method(notificationsShow),
};
