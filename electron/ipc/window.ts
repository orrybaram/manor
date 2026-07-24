import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { createDetachedWindow } from "../window";
import type { IpcDeps } from "./types";
import type { DetachedTabPayload } from "../../src/store/detach-types";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function register(deps: IpcDeps): void {
  // One-shot handoff payloads, keyed by the detached window's stable windowId.
  // The detached renderer pulls its payload once on boot via
  // `window:getDetachPayload` (state can't ride through `loadFile`).
  const payloadByWindowId = new Map<string, DetachedTabPayload>();
  // Reverse lookup so a handler can resolve the caller's windowId from its
  // webContents (BrowserWindow.fromWebContents → id → windowId).
  const windowIdByWebContentsId = new Map<number, string>();

  ipcMain.handle(
    "window:detachTab",
    (_event, payload: DetachedTabPayload, spawnBounds: Bounds): string => {
      const windowId = `detached-${randomUUID()}`;
      const win = createDetachedWindow(windowId, spawnBounds);
      // Track for broadcast + keyed lookup by windowId (ticket 1 registry).
      deps.registerDetachedWindow(windowId, win);

      const webContentsId = win.webContents.id;
      payloadByWindowId.set(windowId, payload);
      windowIdByWebContentsId.set(webContentsId, windowId);

      // Safety net: drop any un-consumed payload if the window closes before it
      // asks for one (the normal path deletes it on getDetachPayload).
      win.on("closed", () => {
        payloadByWindowId.delete(windowId);
        windowIdByWebContentsId.delete(webContentsId);
      });

      return windowId;
    },
  );

  ipcMain.handle(
    "window:getDetachPayload",
    (event): DetachedTabPayload | null => {
      const windowId = windowIdByWebContentsId.get(event.sender.id);
      if (!windowId) return null;
      const payload = payloadByWindowId.get(windowId) ?? null;
      // One-shot: consume it so a reload can't re-hydrate a stale tab.
      payloadByWindowId.delete(windowId);
      return payload;
    },
  );

  ipcMain.handle("window:getBounds", (event): Bounds => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { x: 0, y: 0, width: 0, height: 0 };
    return win.getBounds();
  });
}
