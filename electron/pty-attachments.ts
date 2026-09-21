/**
 * Who owns a session's winsize (ADR-178 D5, ADR-179 D6, ADR-180 D6).
 *
 * One winsize owner per session. Slice 1 (ADR-178) made the desktop app it
 * whenever the desktop had the pane mounted, full stop — every browser on the
 * bridge followed, and nothing here answered what happens between two
 * browsers. ADR-179 D6 closed that gap for the bridge's side. ADR-180 D6
 * closes the last of it: a viewer is a *connection* now, whichever transport
 * carried it, so the two windows a pane is open in are as comparable as two
 * browsers are. ADR-163/164/165 are three records of the single bug that
 * appears when a viewer's grid disagrees with the pty's winsize, and two
 * xterm.js viewers of different widths both running fit-addon would rebuild
 * it as a feature.
 *
 * The rules, in the order they are asked:
 *
 * 1. A `local` viewer — an Electron renderer window on this machine —
 *    outranks a `device` viewer. The user at the desk is the one holding the
 *    keyboard, and a phone looking at the same pane follows.
 * 2. Among viewers of the same class, the most recently attached wins. This
 *    is the ADR-180 repair: before it, two desktop windows on one pane both
 *    believed they owned the winsize and took turns resizing the session to
 *    their own measurement on every layout tick.
 * 3. Whoever stops being the owner — or starts — is told, through
 *    `onAttachmentChange`. A viewer never has to ask.
 *
 * This is a module-level registry rather than something hung off `IpcDeps`
 * because there is exactly one host per main process, and every caller — the
 * bridge's handler table, the bridge server's disconnect handler, a window
 * dying in `app-lifecycle.ts` — must be looking at the same set or the
 * question has two answers. It moves into the daemon when a host can exist
 * with no Electron main to ask (ADR-178 D5).
 */

/**
 * One viewer holding a pane: a bridge connection, and what class of caller it
 * is (ADR-180 D6).
 *
 * A plain `Set<number>` of `webContents.id`s was slice 1's whole story,
 * because every viewer was the desktop and the desktop was one thing. Slice 2
 * added a second, kinded shape for a socket. What this is now is neither: a
 * connection id and a caller class, which is exactly what `BridgeConnection`
 * knows about anyone who reaches the host surface — a renderer window and a
 * paired device arrive here through the same door and are told apart by the
 * only thing that distinguishes them.
 */
export interface Viewer {
  /** The `BridgeConnection.id` that attached. */
  connectionId: string;
  /** `local` = an Electron renderer window; `device` = a paired device. */
  callerClass: "local" | "device";
}

/** What an attach/release call did to ownership. */
export interface AttachmentResult {
  /** Pane ids whose owner changed as a result of this call. */
  changed: string[];
}

/**
 * `paneId` → the viewers holding it, oldest first.
 *
 * An array rather than a `Set` because ownership among equals is about
 * *order* — "the most recently attached" — which a `Set`'s iteration order
 * happens to preserve today but was never the contract. Keyed by viewer, as
 * slice 1's map was, for the same reason: a connection that dies has to
 * release exactly what it held, and a pane open in two places is still owned
 * after one of them lets go.
 */
const holders = new Map<string, Viewer[]>();

/**
 * A sink told which panes just got a new answer to `ownerOf`.
 *
 * `bridge/server.ts` is the one subscriber that exists today: it looks up
 * each changed pane's current grid and tells every connection watching it
 * `owner: boolean`, so a follower whose owner disappeared — or a follower who
 * just became the owner — hears about it without having to ask again. This
 * module stays Electron-free and ignorant of transports, the same reason
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
  return a.connectionId === b.connectionId;
}

/** A stable string to compare "did the owner change" against. */
function ownerFingerprint(viewer: Viewer | null): string {
  return viewer ? `${viewer.callerClass}:${viewer.connectionId}` : "";
}

/**
 * Who owns this pane's winsize: the most recently attached `local` viewer if
 * there is one, else the most recently attached `device` viewer, else null
 * (nobody has it open).
 */
export function ownerOf(paneId: string): Viewer | null {
  const viewers = holders.get(paneId);
  if (!viewers || viewers.length === 0) return null;
  return mostRecent(viewers, "local") ?? mostRecent(viewers, "device");
}

function mostRecent(
  viewers: readonly Viewer[],
  callerClass: Viewer["callerClass"],
): Viewer | null {
  for (let i = viewers.length - 1; i >= 0; i--) {
    if (viewers[i].callerClass === callerClass) return viewers[i];
  }
  return null;
}

/**
 * Would this viewer own the pane's winsize if it attached right now?
 *
 * What a create-shaped call has to know *before* it runs (`createShaped` in
 * `bridge/handlers/pty.ts`): the caller's `cols×rows` is a request, and it may
 * only be granted to the viewer that is about to own the pane — everyone else
 * is handed the owner's grid to render instead.
 *
 * The one case that is not "read the rules off `ownerOf`" is a viewer that
 * already holds the pane. Its attach moves nothing (see `attach`), so a
 * follower re-creating a pane it never let go of — a remount, a workspace
 * switched away from and back — is still a follower. Answering otherwise
 * would let a remount resize the owner's session, which is the whole of
 * ADR-163/164/165 arriving through a door marked "reattach".
 */
export function wouldOwn(paneId: string, viewer: Viewer): boolean {
  const owner = ownerOf(paneId);
  if (!owner) return true;
  if (owner.connectionId === viewer.connectionId) return true;
  const viewers = holders.get(paneId) ?? [];
  if (viewers.some((v) => v.connectionId === viewer.connectionId)) return false;
  // A new arrival: `local` outranks `device`, and among equals the most
  // recent attach — this one — wins.
  return viewer.callerClass === "local" || owner.callerClass === "device";
}

/**
 * A viewer has this pane mounted.
 *
 * A viewer already holding the pane stays where it is in the order rather
 * than moving to the end: a renderer that re-creates a pane it never let go
 * of (a remount, a StrictMode double-mount) is not a new viewer arriving, and
 * taking the winsize back off whoever holds it would make a remount a resize.
 */
export function attach(paneId: string, viewer: Viewer): AttachmentResult {
  const before = ownerFingerprint(ownerOf(paneId));
  const viewers = holders.get(paneId);
  if (viewers) {
    if (!viewers.some((existing) => sameViewer(existing, viewer))) {
      viewers.push(viewer);
    }
  } else {
    holders.set(paneId, [viewer]);
  }
  const after = ownerFingerprint(ownerOf(paneId));
  const changed = before === after ? [] : [paneId];
  notifyChanged(changed);
  return { changed };
}

/**
 * A viewer let this pane go.
 *
 * Without a `viewer` the pane is released outright — every viewer of it at
 * once. Nothing on the host surface asks for that (a caller is only ever done
 * with its own view; a caller that vanished is `releaseViewer`); it is kept
 * for the tests and for a future caller that genuinely means "this pane is
 * gone".
 */
export function release(paneId: string, viewer?: Viewer): AttachmentResult {
  if (viewer === undefined) {
    const had = holders.has(paneId);
    holders.delete(paneId);
    const changed = had ? [paneId] : [];
    notifyChanged(changed);
    return { changed };
  }
  const before = ownerFingerprint(ownerOf(paneId));
  const viewers = holders.get(paneId);
  if (!viewers) return { changed: [] };
  const idx = viewers.findIndex((existing) => sameViewer(existing, viewer));
  if (idx === -1) return { changed: [] };
  viewers.splice(idx, 1);
  if (viewers.length === 0) holders.delete(paneId);
  const after = ownerFingerprint(ownerOf(paneId));
  const changed = before === after ? [] : [paneId];
  notifyChanged(changed);
  return { changed };
}

/**
 * A connection is gone — a window closed, a socket dropped: drop every pane
 * it was holding.
 *
 * One function for both, and no `kind` argument, which is ADR-180 D6's point:
 * a dead renderer window and a dead socket are the same event now, and the
 * old two-kinded version had a hole in exactly this shape — the bridge server
 * called it with `"bridge"` for every dropped connection, which released
 * nothing at all the moment a desktop window's panes started being held under
 * its connection id.
 */
export function releaseViewer(connectionId: string): AttachmentResult {
  const changed: string[] = [];
  for (const [paneId, viewers] of holders) {
    const idx = viewers.findIndex((v) => v.connectionId === connectionId);
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

/** Forget everything. Tests only — a real main process never wants this. */
export function resetAttachments(): void {
  holders.clear();
}
