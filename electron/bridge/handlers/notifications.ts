import type { BrowserWindow } from "electron";
import { assertString } from "../../ipc-validate";
import { sendNotificationsUpdate, showPrNotification } from "../../notifications";
import type { PrNotifyEventKind } from "../../notifications";
import type { PrComment } from "../../../src/lib/pr-info";
import type { IpcDeps } from "../../ipc/types";
import type { LayoutOrigin } from "../../layout/layout-store";

/**
 * The durable notification log (ADR-162, ADR-180 ticket 7). Main owns the
 * list; the renderer keeps a cache of it and never mutates its copy
 * speculatively — every mutation re-broadcasts the whole list through the
 * single send-site in `../notifications`. Every one of these was an
 * `ipcMain.handle` wrapper; the handler table is the only caller left.
 */
export function notificationsGetAll(deps: IpcDeps): unknown {
  return deps.notificationStore.getAll();
}

export function notificationsMarkRead(deps: IpcDeps, id: string): void {
  assertString(id, "id");
  if (deps.notificationStore.markRead(id)) {
    sendNotificationsUpdate(deps.mainWindow);
  }
}

export function notificationsMarkAllRead(deps: IpcDeps): void {
  deps.notificationStore.markAllRead();
  sendNotificationsUpdate(deps.mainWindow);
}

export function notificationsClear(deps: IpcDeps): void {
  deps.notificationStore.clear();
  sendNotificationsUpdate(deps.mainWindow);
}

/**
 * The window a `notifications.show` call is asking on behalf of, for the
 * focus check `showPrNotification` makes (suppress the native banner while
 * that window is focused, so the caller toasts instead).
 *
 * A window's origin names its own `webContents.id` — the poller may be
 * running in a detached window (ADR-156), and it is that window's focus that
 * matters, not the primary's. A device has no window at all, and gets the
 * primary's, which is the same answer `BrowserWindow.fromWebContents` gave
 * when it came up empty under the old `ipcMain.handle`.
 */
function windowForOrigin(
  deps: IpcDeps,
  origin: LayoutOrigin | undefined,
): BrowserWindow | null {
  if (origin?.kind === "window") {
    const id = Number(origin.id);
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
  deps: IpcDeps,
  payload: {
    kind: PrNotifyEventKind;
    title: string;
    body: string;
    url?: string;
    comment?: PrComment;
  },
  origin?: LayoutOrigin,
): boolean {
  assertString(payload.title, "title");
  assertString(payload.body, "body");
  if (payload.comment !== undefined) {
    assertString(payload.comment.author, "comment.author");
    assertString(payload.comment.body, "comment.body");
    assertString(payload.comment.url, "comment.url");
    assertString(payload.comment.createdAt, "comment.createdAt");
  }
  const callerWindow = windowForOrigin(deps, origin);
  return showPrNotification(payload, callerWindow, deps.preferencesManager);
}
