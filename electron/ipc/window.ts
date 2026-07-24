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
      // Idempotent read — do NOT delete on get. React StrictMode (dev) mounts
      // the renderer effect twice; a delete-on-get would let the first, later
      // cancelled, effect run consume the payload so the second run receives
      // null and boots into the empty state. The payload is instead retained
      // for this window's lifetime and dropped in the `closed` handler below,
      // which also makes a manual reload re-hydrate the same tab.
      return payloadByWindowId.get(windowId) ?? null;
    },
  );

  ipcMain.handle("window:getBounds", (event): Bounds => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { x: 0, y: 0, width: 0, height: 0 };
    return win.getBounds();
  });

  // Reverse of detachTab: a detached window sends its tab back to the primary
  // window, then this closes the detached window. The detached renderer has
  // already released its panes (removeDetachedTabLocally) before invoking, so
  // by the time the window closes its store is empty and its beforeunload
  // handler kills nothing.
  ipcMain.handle(
    "window:reattachTab",
    (event, payload: DetachedTabPayload): void => {
      // deps.mainWindow is the PRIMARY window (ticket 1 registry). Forward the
      // payload so the primary renderer inserts the tab into its active panel.
      const primary = deps.mainWindow;
      if (
        primary &&
        !primary.isDestroyed() &&
        !primary.webContents.isDestroyed()
      ) {
        primary.webContents.send("window:tab-reattached", payload);
      }
      // Close the calling (detached) window.
      BrowserWindow.fromWebContents(event.sender)?.close();
    },
  );
}
