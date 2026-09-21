import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { createDetachedWindow, formatClaimArg } from "../window";
import type { IpcDeps } from "./types";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A drop-target window as seen by a renderer performing a tab drag. */
export interface WindowInfo {
  /** webContents id — the same id a claim is keyed by (ADR-179 D4). */
  id: number;
  bounds: Bounds;
}

/**
 * Close a window on a later tick rather than inside the current IPC dispatch.
 *
 * Every caller here is a window asking to be torn down from inside something
 * Chromium is still running: a popout closing from a `dragend` handler, or one
 * whose claim was taken away. The browser process still holds native state for
 * that stack — an in-flight drag session, the view that raised the event — and
 * freeing the window underneath it is a use-after-free (see #164). A tick
 * costs nothing and removes the whole class.
 */
function closeWindowSoon(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  setImmediate(() => {
    if (!win.isDestroyed()) win.close();
  });
}

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
  if (win.isFocused()) bump();
  else focusOrder.push(id);
  win.on("focus", bump);
  win.on("closed", () => {
    focusTracked.delete(id);
    const i = focusOrder.indexOf(id);
    if (i !== -1) focusOrder.splice(i, 1);
  });
}

/**
 * Visible manor windows a dragged tab could be dropped into, topmost-first.
 *
 * Shared by `window:listWindows` — which excludes the calling window, since a
 * renderer cannot drop a tab into itself — and `GET /windows`, which passes no
 * exclusion and so lists them all.
 */
export function listWindows(
  wins: BrowserWindow[],
  excludeWebContentsId?: number,
): WindowInfo[] {
  wins.forEach(trackFocusOrder);
  const rank = (win: BrowserWindow): number => {
    const i = focusOrder.indexOf(win.webContents.id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return wins
    .filter((win) => win.webContents.id !== excludeWebContentsId)
    .filter((win) => win.isVisible() && !win.isMinimized())
    .sort((a, b) => rank(a) - rank(b))
    .map((win) => ({ id: win.webContents.id, bounds: win.getBounds() }));
}

export function register(deps: IpcDeps): void {
  /**
   * Pop a tab out into a window of its own (ADR-179 D4).
   *
   * Nothing moves. The tab stays exactly where it is in the workspace — a
   * browser goes on seeing it — and the new window boots the ordinary renderer
   * with a **claim** on it, which it reports as viewport. The server tells
   * every renderer who is holding what, and the primary hides the tab because
   * of that report, not because anything was handed over. There is no payload
   * to lose and no session to re-attach: the pane is the same pane.
   */
  ipcMain.handle(
    "window:detachTab",
    (_event, workspacePath: string, tabId: string, spawnBounds?: Bounds) => {
      const windowId = `detached-${randomUUID()}`;
      const win = createDetachedWindow(
        windowId,
        formatClaimArg(workspacePath, tabId),
        spawnBounds,
      );
      deps.registerDetachedWindow(windowId, win);
      return windowId;
    },
  );

  ipcMain.handle("window:getBounds", (event): Bounds => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { x: 0, y: 0, width: 0, height: 0 };
    return win.getBounds();
  });

  ipcMain.handle("window:listWindows", (event): WindowInfo[] =>
    listWindows(deps.getRendererWindows(), event.sender.id),
  );

  /**
   * Close the calling window — which is also how a detached window gives its
   * tab back: the claim dies with the window and the tab reappears in the
   * primary, with the same panes and the same live sessions (D4).
   */
  ipcMain.on("window:closeSelf", (event) => {
    closeWindowSoon(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.on("window:setPosition", (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setPosition(Math.round(x), Math.round(y));
  });
}
