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

/** A drop-target window as seen by a renderer performing a tab drag. */
interface WindowInfo {
  /** webContents id — stable handle for `window:transferTab`. */
  id: number;
  bounds: Bounds;
}

export function register(deps: IpcDeps): void {
  // Electron exposes no z-order, so we approximate "topmost" with focus recency:
  // webContents ids, most-recently-focused first. Used to pick a single drop
  // target when a drop point falls inside more than one window's bounds.
  const focusOrder: number[] = [];
  const focusTracked = new Set<number>();

  function trackFocusOrder(win: BrowserWindow): void {
    const id = win.webContents.id;
    if (focusTracked.has(id)) return;
    focusTracked.add(id);
    const bump = () => {
      const i = focusOrder.indexOf(id);
      if (i !== -1) focusOrder.splice(i, 1);
      focusOrder.unshift(id);
    };
    // Seed: a window first seen while focused is topmost; anything else goes to
    // the back until it is actually focused.
    if (win.isFocused()) bump();
    else focusOrder.push(id);
    win.on("focus", bump);
    win.on("closed", () => {
      focusTracked.delete(id);
      const i = focusOrder.indexOf(id);
      if (i !== -1) focusOrder.splice(i, 1);
    });
  }

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

  // Every OTHER manor window a dragged tab could be dropped into, topmost-first.
  // Fetched once when a drag starts; the renderer hit-tests the release point
  // against these bounds locally rather than round-tripping on every move.
  ipcMain.handle("window:listWindows", (event): WindowInfo[] => {
    const wins = deps.getRendererWindows();
    wins.forEach(trackFocusOrder);
    const rank = (win: BrowserWindow): number => {
      const i = focusOrder.indexOf(win.webContents.id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return wins
      .filter((win) => win.webContents.id !== event.sender.id)
      .filter((win) => win.isVisible() && !win.isMinimized())
      .sort((a, b) => rank(a) - rank(b))
      .map((win) => ({ id: win.webContents.id, bounds: win.getBounds() }));
  });

  // Hand a tab to another existing window (drag-and-drop between windows).
  // Resolves false when the target is gone, so the caller can fall back to
  // spawning a new window instead of dropping the tab on the floor.
  ipcMain.handle(
    "window:transferTab",
    (_event, targetWindowId: number, payload: DetachedTabPayload): boolean => {
      const target = deps
        .getRendererWindows()
        .find((win) => win.webContents.id === targetWindowId);
      if (!target) return false;
      target.webContents.send("window:tab-received", payload);
      if (target.isMinimized()) target.restore();
      target.focus();
      return true;
    },
  );

  // Close the calling window. Used by a detached window that just gave away its
  // last tab — its store is already empty, so `beforeunload` kills nothing.
  ipcMain.on("window:closeSelf", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // Move the calling window's top-left to a screen-space point. Fire-and-forget
  // (`on`, not `handle`): this is driven at pointermove frequency when a window
  // whose only tab is being dragged follows the cursor instead of tearing off.
  ipcMain.on("window:setPosition", (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setPosition(Math.round(x), Math.round(y));
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
