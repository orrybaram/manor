import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import { sendNotificationsUpdate } from "../notifications";
import type { IpcDeps } from "./types";

/**
 * The durable notification log (ADR-162). Main owns the list; the renderer
 * keeps a cache of it and never mutates its copy speculatively — every
 * mutation here re-broadcasts the whole list through the single send-site in
 * `../notifications`.
 */
/** Lifted for the ADR-178 bridge; see `electron/remote-control/ws-handlers.ts`. */
export function notificationsGetAll(deps: IpcDeps): unknown {
  return deps.notificationStore.getAll();
}

export function register(deps: IpcDeps): void {
  const { notificationStore } = deps;

  const broadcast = () => sendNotificationsUpdate(deps.mainWindow);

  ipcMain.handle("notifications:getAll", () => notificationsGetAll(deps));

  ipcMain.handle("notifications:markRead", (_event, id: string) => {
    assertString(id, "id");
    if (notificationStore.markRead(id)) broadcast();
  });

  ipcMain.handle("notifications:markAllRead", () => {
    notificationStore.markAllRead();
    broadcast();
  });

  ipcMain.handle("notifications:clear", () => {
    notificationStore.clear();
    broadcast();
  });
}
