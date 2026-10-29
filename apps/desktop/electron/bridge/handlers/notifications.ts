import { assertString } from "../../ipc-validate";
import type { PrNotifyEventKind } from "../../notifications";
import type { PrComment } from "../../../src/lib/pr-info";
import type { NotificationRecord } from "../../notification-store";
import type { ServerDeps, SharedDeps } from "../../ipc/types";
import { LOCAL_HOST_ID } from "../../../src/lib/workspace-key";
import { LOCAL_ROUTE, byHost, method, type HandlerCtx } from "../method";

/**
 * The durable notification log. Main owns the
 * list; the renderer keeps a cache of it and never mutates its copy
 * speculatively — every mutation re-broadcasts the whole list through the
 * single send-site in `../../notifications`.
 *
 * Every server keeps its own: a host server's holds its automations' runs,
 * which fire with no desktop open. `getAll` is the server's log as it hands
 * it out (`notificationLog`) — on the desktop, with each adopted host's
 * merged in; in the renderer's router, every server's merged. A write names
 * the host whose log it marks (null for this server's own), so the desktop
 * forwards one for an adopted host to that host's server (`byHost`). One
 * that lands here for another host is for a host with no server keeping a
 * log: there is nothing to mark.
 */

type LogDeps = Pick<SharedDeps, "notificationStore" | "notificationLog" | "notifier">;

/** Whether `hostId` names this server's own log. */
function isOwnLog(hostId: string | null | undefined): boolean {
  if (hostId === null || hostId === undefined || hostId === "" || hostId === LOCAL_HOST_ID) return true;
  assertString(hostId, "hostId");
  return false;
}

export function notificationsGetAll(ctx: HandlerCtx<LogDeps>): NotificationRecord[] {
  return ctx.deps.notificationLog();
}

/**
 * Whether anything changed: `markRead` is false for an id that is unknown *or*
 * already read, and only a real transition is worth a broadcast.
 */
export function notificationsMarkRead(
  ctx: HandlerCtx<LogDeps>,
  id: string,
  hostId?: string | null,
): boolean {
  assertString(id, "id");
  if (!isOwnLog(hostId)) return false;
  const changed = ctx.deps.notificationStore.markRead(id);
  if (changed) ctx.deps.notifier.sendNotificationsUpdate();
  return changed;
}

export function notificationsMarkAllRead(ctx: HandlerCtx<LogDeps>, hostId?: string | null): void {
  if (!isOwnLog(hostId)) return;
  ctx.deps.notificationStore.markAllRead();
  ctx.deps.notifier.sendNotificationsUpdate();
}

export function notificationsClear(ctx: HandlerCtx<LogDeps>, hostId?: string | null): void {
  if (!isOwnLog(hostId)) return;
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
  getAll: method(notificationsGetAll, { route: LOCAL_ROUTE }),
  markRead: method(notificationsMarkRead, { route: byHost(1), mutating: true }),
  markAllRead: method(notificationsMarkAllRead, { route: byHost(0), mutating: true }),
  clear: method(notificationsClear, { route: byHost(0), mutating: true }),
  show: method(notificationsShow, { route: LOCAL_ROUTE }),
};
