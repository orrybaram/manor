/**
 * Who owns a session's winsize (ADR-178 D5, ADR-179 D6).
 *
 * One winsize owner per session. Slice 1 (ADR-178) made the desktop app it
 * whenever the desktop has the pane mounted, full stop — every browser on the
 * bridge followed, and nothing here answered what happens between two
 * browsers. ADR-179 D6 closes that gap: with no desktop viewer, the most
 * recently attached bridge viewer owns it, and everyone else — every other
 * browser, and a desktop that later attaches — follows. ADR-163/164/165 are
 * three records of the single bug that appears when a viewer's grid disagrees
 * with the pty's winsize, and two xterm.js viewers of different widths both
 * running fit-addon would rebuild it as a feature.
 *
 * Main is where the check lives in slice 1 because main already sees every
 * desktop attach and detach: `pty:create` from a renderer window is an attach,
 * `pty:close` and `pty:detach` are releases, and a window that dies releases
 * everything it held. The bridge server sees the same events for a browser —
 * `pty.create`/`pty.reset` attach, `pty.close`/`pty.detach`/a dropped socket
 * release. Nothing here is asked of the daemon, which has a `Set` of attached
 * clients but no idea which of them is a desktop window or a browser tab.
 *
 * This is a module-level registry rather than something hung off `IpcDeps`
 * because there is exactly one desktop per main process, and every caller —
 * the `ipcMain` wrappers, the bridge's handler table, the bridge server's
 * disconnect handler — must be looking at the same set or the question has
 * two answers. It moves into the daemon when a host can exist with no
 * Electron main to ask (D5).
 */

/** The stand-in viewer id for a caller that cannot name its `webContents`. */
const DESKTOP_VIEWER = -1;

/**
 * One viewer holding a pane: a desktop `webContents.id`, or a bridge
 * connection id (ADR-179 D6).
 *
 * A plain `Set<number>` was slice 1's whole story because every viewer was
 * the desktop. Telling two bridge sockets apart — and telling "the most
 * recently attached one" — needs an ordered, kinded list instead.
 */
export type Viewer =
  | { kind: "desktop"; id: number }
  | { kind: "bridge"; id: string };

/** What an attach/release call did to ownership. */
export interface AttachmentResult {
  /** Pane ids whose owner changed as a result of this call. */
  changed: string[];
}

/**
 * `paneId` → the viewers holding it, oldest first.
 *
 * An array rather than a `Set` because ownership among bridge viewers is
 * about *order* — "the most recently attached" — which a `Set`'s iteration
 * order happens to preserve today but was never the contract. Keyed by
 * viewer, as slice 1's map was, for the same reason: a window (or a browser
 * reconnect) that dies has to release exactly what it held, and a pane open
 * in two places is still owned after one of them lets go.
 */
const holders = new Map<string, Viewer[]>();

/**
 * A sink told which panes just got a new answer to `ownerOf`.
 *
 * `bridge/server.ts` is the one subscriber that exists today: it looks up
 * each changed pane's current grid and tells every connection watching it
 * `owner: boolean`, so a follower whose owner disappeared — or a follower who
 * just became the owner — hears about it without having to ask again. This
 * module stays Electron-free and ignorant of sockets, the same reason
 * `renderer-broadcast.ts` is a leaf: the registry only knows *that* ownership
 * moved, never who is listening.
 */
type ChangeSink = (paneId: string) => void;

const changeSinks = new Set<ChangeSink>();

/** Register a sink. Returns the unsubscribe. */
export function onAttachmentChange(sink: ChangeSink): () => void {
  changeSinks.add(sink);
  return () => {
    changeSinks.delete(sink);
  };
}

function notifyChanged(changed: readonly string[]): void {
  for (const paneId of changed) {
    for (const sink of changeSinks) sink(paneId);
  }
}

function sameViewer(a: Viewer, b: Viewer): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** A stable string to compare "did the owner change" against. */
function ownerFingerprint(viewer: Viewer | null): string {
  return viewer ? `${viewer.kind}:${viewer.id}` : "";
}

/**
 * Who owns this pane's winsize: a desktop viewer if any is attached, else the
 * most recently attached bridge viewer, else null (nobody has it open).
 */
export function ownerOf(paneId: string): Viewer | null {
  const viewers = holders.get(paneId);
  if (!viewers || viewers.length === 0) return null;
  const desktop = viewers.find((v) => v.kind === "desktop");
  if (desktop) return desktop;
  for (let i = viewers.length - 1; i >= 0; i--) {
    if (viewers[i].kind === "bridge") return viewers[i];
  }
  return null;
}

/**
 * A viewer has this pane mounted.
 *
 * `viewerId = DESKTOP_VIEWER` keeps every call site that cannot name its
 * `webContents` (tests, mainly) working as a desktop attach with no id.
 */
export function attach(
  paneId: string,
  viewer: Viewer | number = DESKTOP_VIEWER,
): AttachmentResult {
  const v: Viewer =
    typeof viewer === "number" ? { kind: "desktop", id: viewer } : viewer;
  const before = ownerFingerprint(ownerOf(paneId));
  const viewers = holders.get(paneId);
  if (viewers) {
    if (!viewers.some((existing) => sameViewer(existing, v))) viewers.push(v);
  } else {
    holders.set(paneId, [v]);
  }
  const after = ownerFingerprint(ownerOf(paneId));
  const changed = before === after ? [] : [paneId];
  notifyChanged(changed);
  return { changed };
}

/**
 * A viewer let this pane go.
 *
 * Without a `viewerId` the pane is released outright — the caller is saying
 * the desktop is done with it, not that one of several windows is. (No
 * bridge caller omits its id; a browser is never "done with everything at
 * once" short of disconnecting, which is `releaseViewer`.)
 */
export function release(
  paneId: string,
  viewer?: Viewer | number,
): AttachmentResult {
  if (viewer === undefined) {
    const had = holders.has(paneId);
    holders.delete(paneId);
    const changed = had ? [paneId] : [];
    notifyChanged(changed);
    return { changed };
  }
  const v: Viewer =
    typeof viewer === "number" ? { kind: "desktop", id: viewer } : viewer;
  const before = ownerFingerprint(ownerOf(paneId));
  const viewers = holders.get(paneId);
  if (!viewers) return { changed: [] };
  const idx = viewers.findIndex((existing) => sameViewer(existing, v));
  if (idx === -1) return { changed: [] };
  viewers.splice(idx, 1);
  if (viewers.length === 0) holders.delete(paneId);
  const after = ownerFingerprint(ownerOf(paneId));
  const changed = before === after ? [] : [paneId];
  notifyChanged(changed);
  return { changed };
}

/**
 * A desktop window died, or a bridge connection dropped: drop every pane it
 * was holding.
 *
 * `kind` defaults to `"desktop"` for the existing window-death caller; the
 * bridge server passes `"bridge"` on a socket close.
 */
export function releaseViewer(
  viewerId: number | string,
  kind: "desktop" | "bridge" = "desktop",
): AttachmentResult {
  const changed: string[] = [];
  for (const [paneId, viewers] of holders) {
    const idx = viewers.findIndex(
      (v) => v.kind === kind && v.id === viewerId,
    );
    if (idx === -1) continue;
    const before = ownerFingerprint(ownerOf(paneId));
    viewers.splice(idx, 1);
    if (viewers.length === 0) holders.delete(paneId);
    const after = ownerFingerprint(ownerOf(paneId));
    if (before !== after) changed.push(paneId);
  }
  notifyChanged(changed);
  return { changed };
}

/**
 * Is the desktop app the winsize owner of this pane?
 *
 * `false` means the next viewer to attach may own the winsize — which, on the
 * bridge, is the browser asking. Kept for existing callers who only ever
 * asked "is it the desktop's" and never cared which bridge viewer, if any,
 * is otherwise in the running.
 */
export function isDesktopAttached(paneId: string): boolean {
  return (holders.get(paneId) ?? []).some((v) => v.kind === "desktop");
}

/** Forget everything. Tests only — a real main process never wants this. */
export function resetAttachments(): void {
  holders.clear();
}
