/**
 * Who owns a session's winsize (ADR-178 D5).
 *
 * One winsize owner per session, and the desktop app is it while it has the
 * pane mounted. Everything else — a browser on the bridge, the remote client —
 * follows: it renders the owner's `cols×rows` as they are and never asks for a
 * different pair. ADR-163/164/165 are three records of the single bug that
 * appears when a viewer's grid disagrees with the pty's winsize, and two
 * xterm.js viewers of different widths both running fit-addon would rebuild it
 * as a feature.
 *
 * Main is where the check lives in slice 1 because main already sees every
 * desktop attach and detach: `pty:create` from a renderer window is an attach,
 * `pty:close` and `pty:detach` are releases, and a window that dies releases
 * everything it held. Nothing here is asked of the daemon, which has a `Set` of
 * attached clients but no idea which of them is an Electron window.
 *
 * This is a module-level registry rather than something hung off `IpcDeps`
 * because there is exactly one desktop per main process, and the two callers —
 * the `ipcMain` wrappers and the bridge's handler table — must be looking at
 * the same set or the question has two answers. It moves into the daemon when
 * a host can exist with no Electron main to ask (D5).
 */

/** The stand-in viewer id for a caller that cannot name its `webContents`. */
const DESKTOP_VIEWER = -1;

/**
 * `paneId` → the renderer `webContents` ids holding it.
 *
 * Keyed by viewer rather than a plain `Set<paneId>` because window death has to
 * release exactly what that window held: a pane open in the primary window and
 * in a detached window (ADR-156) is still desktop-owned after one of them
 * closes, and a set of pane ids alone cannot say so.
 */
const holders = new Map<string, Set<number>>();

/** A desktop window has this pane mounted. */
export function attach(paneId: string, viewerId = DESKTOP_VIEWER): void {
  const viewers = holders.get(paneId);
  if (viewers) viewers.add(viewerId);
  else holders.set(paneId, new Set([viewerId]));
}

/**
 * A desktop window let this pane go.
 *
 * Without a `viewerId` the pane is released outright — the caller is saying the
 * desktop is done with it, not that one of several windows is.
 */
export function release(paneId: string, viewerId?: number): void {
  if (viewerId === undefined) {
    holders.delete(paneId);
    return;
  }
  const viewers = holders.get(paneId);
  if (!viewers) return;
  viewers.delete(viewerId);
  if (viewers.size === 0) holders.delete(paneId);
}

/** A window died: drop every pane it was holding. */
export function releaseViewer(viewerId: number): void {
  for (const [paneId, viewers] of holders) {
    if (!viewers.delete(viewerId)) continue;
    if (viewers.size === 0) holders.delete(paneId);
  }
}

/**
 * Is the desktop app the winsize owner of this pane?
 *
 * `false` means the next viewer to attach may own the winsize — which, on the
 * bridge, is the browser asking.
 */
export function isDesktopAttached(paneId: string): boolean {
  return (holders.get(paneId)?.size ?? 0) > 0;
}

/** Forget everything. Tests only — a real main process never wants this. */
export function resetAttachments(): void {
  holders.clear();
}
