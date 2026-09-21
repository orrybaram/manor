import type { BrowserWindow } from "electron";
import { assertString } from "../../ipc-validate";
import { sendNotificationsUpdate, showPrNotification } from "../../notifications";
import type { PrNotifyEventKind } from "../../notifications";
import type { PrComment } from "../../../src/lib/pr-info";
import type { NotificationRecord } from "../../notification-store";
import type { HostDeps } from "../../ipc/types";
import { method, type Caller, type HandlerCtx } from "../method";

/**
 * The durable notification log (ADR-162, ADR-180 ticket 7). Main owns the
 * list; the renderer keeps a cache of it and never mutates its copy
 * speculatively — every mutation re-broadcasts the whole list through the
 * single send-site in `../notifications`.
 */
export function notificationsGetAll(ctx: HandlerCtx): NotificationRecord[] {
  return ctx.deps.notificationStore.getAll();
}

/**
 * Whether anything changed: `markRead` is false for an id that is unknown *or*
 * already read, and only a real transition is worth a broadcast.
 */
export function notificationsMarkRead(ctx: HandlerCtx, id: string): boolean {
  assertString(id, "id");
  const changed = ctx.deps.notificationStore.markRead(id);
  if (changed) sendNotificationsUpdate();
  return changed;
}

export function notificationsMarkAllRead(ctx: HandlerCtx): void {
  ctx.deps.notificationStore.markAllRead();
  sendNotificationsUpdate();
}

export function notificationsClear(ctx: HandlerCtx): void {
  ctx.deps.notificationStore.clear();
  sendNotificationsUpdate();
}

/**
 * The window a `notifications.show` call is asking on behalf of, for the
 * focus check `showPrNotification` makes (suppress the native banner while
 * that window is focused, so the caller toasts instead).
 *
 * A local caller's id is its own `webContents.id` — the poller may be
 * running in a detached window (ADR-156), and it is that window's focus that
 * matters, not the primary's. A device has no window at all, and gets the
 * primary's.
 */
function windowForCaller(deps: HostDeps, caller: Caller): BrowserWindow | null {
  if (caller.callerClass === "local") {
    const id = Number(caller.id);
    for (const win of deps.getRendererWindows()) {
      if (!win.isDestroyed() && win.webContents.id === id) return win;
    }
  }
  return deps.mainWindow;
}

/**
 * Show a native notification on demand (e.g. a PR update alert, ADR-147).
 * Resolves whether it was presented — `false` means the calling window is
 * focused, and the caller should show an in-app toast instead; see
 * `presentNotification` in `../notifications`.
 */
export function notificationsShow(
  ctx: HandlerCtx,
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
  const callerWindow = windowForCaller(ctx.deps, ctx.caller);
  return showPrNotification(payload, callerWindow, ctx.deps.preferencesManager);
}

export const notifications = {
  getAll: method(notificationsGetAll),
  markRead: method(notificationsMarkRead, { mutating: true }),
  markAllRead: method(notificationsMarkAllRead, { mutating: true }),
  clear: method(notificationsClear, { mutating: true }),
  show: method(notificationsShow),
};
