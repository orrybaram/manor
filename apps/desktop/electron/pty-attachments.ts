/**
 * Who owns a session's winsize.
 *
 * One winsize owner per session. At first the desktop app was it whenever
 * the desktop had the pane mounted, full stop — every browser on the bridge
 * followed, and nothing here answered what happens between two browsers.
 * That gap is closed: a viewer is a *connection* now, whichever transport
 * carried it, so the two windows a pane is open in are as comparable as two
 * browsers are. A viewer's grid disagreeing with the pty's winsize is a bug
 * that has surfaced more than once, and two xterm.js viewers of different
 * widths both running fit-addon would rebuild it as a feature.
 *
 * The rules, in the order they are asked:
 *
 * 1. A `local` viewer — an Electron renderer window on this machine —
 *    outranks a `device` viewer. The user at the desk is the one holding the
 *    keyboard, and a phone looking at the same pane follows. On a host
 *    server, a desktop window's own viewer stream (`viewer: "desktop"`) is
 *    that desk, and ranks the same.
 *    A device ranks below every other viewer, too — the owner channel
 *    included — and never claims: a phone mostly shows the chat, and every
 *    way it used to take the winsize from a desktop (arriving last beside
 *    the owner channel, or "fit to this screen") left the desk's terminal
 *    phone-narrow with no way back from the desk. A device alone on a pane
 *    still owns it, and the desk takes it back by attaching.
 * 2. Among viewers of the same class, the most recently attached wins. This
 *    is a repair: before it, two desktop windows on one pane both
 *    believed they owned the winsize and took turns resizing the session to
 *    their own measurement on every layout tick.
 * 3. Whoever stops being the owner — or starts — is told, through
 *    `onAttachmentChange`. A viewer never has to ask.
 *
 * Rules 1 and 2 are the default; a **claim** overrides them. A viewer that
 * holds a pane can ask for its winsize outright (`claim`). The claim lasts until the claimant lets
 * the pane go, another viewer claims, a new viewer attaches (an arrival is
 * still rule 1 and 2's to decide), or someone types into the pane at the desk
 * (`reclaimOnInput`) — the person at the keyboard gets their grid back
 * without hunting for a button, which is tmux's `window-size latest` with
 * the desk as the only viewer whose keystrokes count implicitly.
 *
 * A **foreign hold** outranks all of it. On a host server the
 * pane's other viewer may be a client of the daemon this registry never sees —
 * another daemon client attached to the same session (the
 * desktop over ssh; now the desktop's windows are viewers here). While the host says so
 * (`setForeign`), nobody here owns the winsize: `ownerOf` answers a sentinel
 * viewer no connection matches, so every resize is dropped, every claim loses
 * and every arrival follows.
 *
 * This is a module-level registry, and shared between servers in one process
 * on purpose. It is keyed by pane id, and a pane belongs to
 * exactly one server, so two servers never contend for an entry. What is
 * process-wide is `changeSinks`: each `BridgeServer` registers one and hears
 * an owner change for every pane, including another server's. That is safe
 * because it pushes `winsizeOwner` only to connections that subscribed to the
 * pane, and a connection subscribes only to its own server's panes. The
 * question every caller asks — who owns this pane's winsize — has one answer.
 * It moves into the daemon when a host can exist with no Electron main to ask.
 *
 * The rules live on `PtyAttachments`, and the module-level functions below
 * are the process's one instance of it (`processAttachments`). Main also
 * arbitrates among the callers it forwards to a host server (`HostRouting`)
 * in that same instance; a test that runs a host server and main
 * in one process gives main's routing an instance of its own.
 */

import type { CallerClass, ViewerKind } from "./bridge/types";

/**
 * One viewer holding a pane: a bridge connection, and what class of caller it
 * is.
 *
 * A plain `Set<number>` of `webContents.id`s was once the whole story,
 * because every viewer was the desktop and the desktop was one thing. Later a
 * second, kinded shape was added for a socket. What this is now is neither: a
 * connection id and a caller class, which is exactly what `BridgeConnection`
 * knows about anyone who reaches the host surface — a renderer window and a
 * paired device arrive here through the same door and are told apart by the
 * only thing that distinguishes them.
 */
export interface Viewer {
  /** The `BridgeConnection.id` that attached. */
  connectionId: string;
  /**
   * `local` = an Electron renderer window; `device` = a paired device;
   * `owner` = the desktop on a host server's owner channel.
   */
  callerClass: CallerClass;
  /**
   * `desktop` = a desktop window's own viewer stream to a host server.
   * Absent for every other viewer.
   */
  viewer?: ViewerKind;
}

/**
 * How a caller class ranks for the winsize: higher wins, and among equals the
 * most recent attach. A window on this machine outranks the owner channel,
 * which is another client of the daemon, not the person at its desk; and a
 * paired device ranks below both (rule 1).
 */
const RANK: Record<CallerClass, number> = {
  local: 1,
  owner: 0,
  device: -1,
};

/** The rank of a desk window, which a desktop viewer stream shares. */
const DESK_RANK = RANK.local;

/**
 * A viewer's rank: its caller class's, except that a desktop viewer stream
 * on a host server is a desk window there, whatever its class (`owner`).
 */
function rankOf(viewer: Viewer): number {
  return viewer.viewer === "desktop" ? DESK_RANK : RANK[viewer.callerClass];
}

/** Whether this viewer is someone at the desk: a window, here or through a viewer stream. */
function isDesk(viewer: Viewer): boolean {
  return rankOf(viewer) === DESK_RANK;
}

/** The connection id of the viewer a foreign hold reports as the owner. */
export const FOREIGN_CONNECTION_ID = "\0foreign";

/**
 * The owner `ownerOf` answers while a pane is held elsewhere. No
 * `BridgeConnection` has this id, so no connection is ever told it owns the
 * pane, and no caller's resize matches it.
 */
const FOREIGN_VIEWER: Viewer = Object.freeze({
  connectionId: FOREIGN_CONNECTION_ID,
  callerClass: "device",
});

/**
 * A sink told which panes just got a new answer to `ownerOf`.
 *
 * `bridge/server.ts` subscribes: it looks up each changed pane's current
 * grid and tells every connection watching it `owner: boolean`, so a follower
 * whose owner disappeared — or a follower who just became the owner — hears
 * about it without having to ask again. `HostRouting` does the same for a
 * pane on a host server, with the host's last grid. This
 * module stays Electron-free and ignorant of transports, the same reason
 * `renderer-broadcast.ts` is a leaf: the registry only knows *that* ownership
 * moved, never who is listening.
 */
type ChangeSink = (paneId: string) => void;

function sameViewer(a: Viewer, b: Viewer): boolean {
  return a.connectionId === b.connectionId;
}

/** A stable string to compare "did the owner change" against. */
function ownerFingerprint(viewer: Viewer | null): string {
  return viewer ? `${viewer.callerClass}:${viewer.connectionId}` : "";
}

function highestRanked(viewers: readonly Viewer[]): Viewer | null {
  let best: Viewer | null = null;
  // Newest first, and only a strictly higher rank displaces: among equals
  // the most recent attach wins.
  for (let i = viewers.length - 1; i >= 0; i--) {
    if (!best || rankOf(viewers[i]) > rankOf(best)) {
      best = viewers[i];
    }
  }
  return best;
}

/** One registry of who holds which pane, and who owns its winsize. */
export class PtyAttachments {
  /**
   * `paneId` → the viewers holding it, oldest first.
   *
   * An array rather than a `Set` because ownership among equals is about
   * *order* — "the most recently attached" — which a `Set`'s iteration order
   * happens to preserve today but was never the contract. Keyed by viewer, as
   * the original map was, for the same reason: a connection that dies has to
   * release exactly what it held, and a pane open in two places is still owned
   * after one of them lets go.
   */
  private readonly holders = new Map<string, Viewer[]>();

  /** `paneId` → the connection that explicitly claimed its winsize. */
  private readonly claims = new Map<string, string>();

  /** Panes a client this registry cannot see holds (`setForeign`). */
  private readonly foreign = new Set<string>();

  private readonly changeSinks = new Set<ChangeSink>();

  /** Register a sink. Returns the unsubscribe. */
  onAttachmentChange(sink: ChangeSink): () => void {
    this.changeSinks.add(sink);
    return () => {
      this.changeSinks.delete(sink);
    };
  }

  private notifyChanged(changed: readonly string[]): void {
    for (const paneId of changed) {
      for (const sink of this.changeSinks) sink(paneId);
    }
  }

  /**
   * Who owns this pane's winsize: the foreign viewer while it is held
   * elsewhere; null when nobody here has it open; the claimant; else the most
   * recently attached viewer of the highest rank.
   *
   * Not "does anyone here hold it" — a held-elsewhere pane has an owner either
   * way. That is `isHeld`.
   */
  ownerOf(paneId: string): Viewer | null {
    if (this.foreign.has(paneId)) return FOREIGN_VIEWER;
    const viewers = this.holders.get(paneId);
    if (!viewers || viewers.length === 0) return null;
    const claimant = this.claims.get(paneId);
    const claimed = claimant && viewers.find((v) => v.connectionId === claimant);
    if (claimed) return claimed;
    return highestRanked(viewers);
  }

  /** Whether any viewer here has this pane open, whoever owns its winsize. */
  isHeld(paneId: string): boolean {
    return (this.holders.get(paneId)?.length ?? 0) > 0;
  }

  /** The viewers holding this pane, oldest first. */
  viewersOf(paneId: string): readonly Viewer[] {
    return [...(this.holders.get(paneId) ?? [])];
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
   * the winsize-disagreement bug arriving through a door marked "reattach".
   */
  wouldOwn(paneId: string, viewer: Viewer): boolean {
    // Held elsewhere: nobody's arrival outranks a viewer this side cannot see.
    if (this.foreign.has(paneId)) return false;
    const owner = this.ownerOf(paneId);
    if (!owner) return true;
    if (owner.connectionId === viewer.connectionId) return true;
    const viewers = this.holders.get(paneId) ?? [];
    if (viewers.some((v) => v.connectionId === viewer.connectionId)) return false;
    // A new arrival: a higher rank outranks, and among equals the most recent
    // attach — this one — wins.
    return rankOf(viewer) >= rankOf(owner);
  }

  /**
   * Run `fn`, which changes who holds or claims this pane, and tell the sinks
   * if that gave it a different owner.
   */
  private changingOwner(paneId: string, fn: () => void): void {
    const before = ownerFingerprint(this.ownerOf(paneId));
    fn();
    const after = ownerFingerprint(this.ownerOf(paneId));
    if (before !== after) this.notifyChanged([paneId]);
  }

  /**
   * A viewer has this pane mounted.
   *
   * A viewer already holding the pane stays where it is in the order rather
   * than moving to the end: a renderer that re-creates a pane it never let go
   * of (a remount, a StrictMode double-mount) is not a new viewer arriving, and
   * taking the winsize back off whoever holds it would make a remount a resize.
   *
   * `as: "returning"` is a viewer that had this pane mounted coming back — its
   * connection dropped and it re-attached (`pty.attach`) — and making
   * no bid for the winsize. It goes in as the *oldest* viewer rather than the
   * newest, and a standing claim stays standing: whoever attached while it was
   * away keeps the grid they have been fitting to, rather than having it
   * reflowed under them by a viewer that merely came back. Rule 1 still holds,
   * so a desk window coming back outranks a device, as it would have before it
   * left. A viewer alone on the pane owns it, as any viewer alone does.
   */
  attach(
    paneId: string,
    viewer: Viewer,
    { as = "newest" }: { as?: "newest" | "returning" } = {},
  ): void {
    this.changingOwner(paneId, () => {
      const viewers = this.holders.get(paneId);
      if (!viewers) {
        this.holders.set(paneId, [viewer]);
        return;
      }
      if (viewers.some((existing) => sameViewer(existing, viewer))) return;
      if (as === "returning") {
        viewers.unshift(viewer);
        return;
      }
      viewers.push(viewer);
      // A new arrival is decided by the default rules, as `wouldOwn` told it.
      this.claims.delete(paneId);
    });
  }

  /**
   * A viewer let this pane go. A caller is only ever done with its own view;
   * a caller that vanished is `releaseViewer`.
   */
  release(paneId: string, viewer: Viewer): void {
    this.changingOwner(paneId, () => {
      const viewers = this.holders.get(paneId);
      if (!viewers) return;
      const idx = viewers.findIndex((existing) => sameViewer(existing, viewer));
      if (idx === -1) return;
      viewers.splice(idx, 1);
      if (viewers.length === 0) this.holders.delete(paneId);
      if (this.claims.get(paneId) === viewer.connectionId) this.claims.delete(paneId);
    });
  }

  /**
   * A viewer that holds this pane takes its winsize. Returns whether it took
   * it: a viewer that does not hold the pane cannot, a device never can, and
   * nobody can while it is held elsewhere.
   */
  claim(paneId: string, viewer: Viewer): boolean {
    if (this.foreign.has(paneId)) return false;
    if (rankOf(viewer) === RANK.device) return false;
    const viewers = this.holders.get(paneId);
    if (!viewers?.some((v) => sameViewer(v, viewer))) return false;
    this.changingOwner(paneId, () => {
      this.claims.set(paneId, viewer.connectionId);
    });
    return true;
  }

  /**
   * Someone typed into this pane. A keystroke at the desk ends another
   * viewer's claim, handing the winsize back to the default rules — which for
   * a desk window holding the pane means the desk.
   */
  reclaimOnInput(paneId: string, viewer: Viewer): void {
    if (!isDesk(viewer)) return;
    const claimant = this.claims.get(paneId);
    if (!claimant || claimant === viewer.connectionId) return;
    this.changingOwner(paneId, () => {
      this.claims.delete(paneId);
    });
  }

  /**
   * A client this registry cannot see holds the pane (`on`), or let it go.
   *
   * Set by a host server from the daemon's attach count (`host-server/winsize.ts`). The hold outlives the viewers here — it is about
   * the session, not about who on this side has it open — and is cleared by
   * whoever set it. A flip that changes `ownerOf` is told to the change sinks
   * like any other, so every connection watching hears `owner: false` (or its
   * own answer again).
   */
  setForeign(paneId: string, on: boolean): void {
    if (this.foreign.has(paneId) === on) return;
    const before = ownerFingerprint(this.ownerOf(paneId));
    if (on) this.foreign.add(paneId);
    else this.foreign.delete(paneId);
    const after = ownerFingerprint(this.ownerOf(paneId));
    if (before !== after) this.notifyChanged([paneId]);
  }

  /**
   * A connection is gone — a window closed, a socket dropped: drop every pane
   * it was holding.
   *
   * One function for both, and no `kind` argument, which is the point:
   * a dead renderer window and a dead socket are the same event now, and the
   * old two-kinded version had a hole in exactly this shape — the bridge server
   * called it with `"bridge"` for every dropped connection, which released
   * nothing at all the moment a desktop window's panes started being held under
   * its connection id.
   */
  releaseViewer(connectionId: string): void {
    const changed: string[] = [];
    for (const [paneId, viewers] of this.holders) {
      const idx = viewers.findIndex((v) => v.connectionId === connectionId);
      if (idx === -1) continue;
      const before = ownerFingerprint(this.ownerOf(paneId));
      viewers.splice(idx, 1);
      if (viewers.length === 0) this.holders.delete(paneId);
      if (this.claims.get(paneId) === connectionId) this.claims.delete(paneId);
      const after = ownerFingerprint(this.ownerOf(paneId));
      if (before !== after) changed.push(paneId);
    }
    this.notifyChanged(changed);
  }

  /** Forget everything. Tests only — a real main process never wants this. */
  reset(): void {
    this.holders.clear();
    this.claims.clear();
    this.foreign.clear();
  }
}

/** The process's registry: the one every function below reads and writes. */
export const processAttachments = new PtyAttachments();

/** Register a sink on the process's registry. Returns the unsubscribe. */
export function onAttachmentChange(sink: ChangeSink): () => void {
  return processAttachments.onAttachmentChange(sink);
}

/** `PtyAttachments.ownerOf`, on the process's registry. */
export function ownerOf(paneId: string): Viewer | null {
  return processAttachments.ownerOf(paneId);
}

/** `PtyAttachments.isHeld`, on the process's registry. */
export function isHeld(paneId: string): boolean {
  return processAttachments.isHeld(paneId);
}

/** `PtyAttachments.wouldOwn`, on the process's registry. */
export function wouldOwn(paneId: string, viewer: Viewer): boolean {
  return processAttachments.wouldOwn(paneId, viewer);
}

/** `PtyAttachments.attach`, on the process's registry. */
export function attach(
  paneId: string,
  viewer: Viewer,
  opts: { as?: "newest" | "returning" } = {},
): void {
  processAttachments.attach(paneId, viewer, opts);
}

/** `PtyAttachments.release`, on the process's registry. */
export function release(paneId: string, viewer: Viewer): void {
  processAttachments.release(paneId, viewer);
}

/** `PtyAttachments.claim`, on the process's registry. */
export function claim(paneId: string, viewer: Viewer): boolean {
  return processAttachments.claim(paneId, viewer);
}

/** `PtyAttachments.reclaimOnInput`, on the process's registry. */
export function reclaimOnInput(paneId: string, viewer: Viewer): void {
  processAttachments.reclaimOnInput(paneId, viewer);
}

/** `PtyAttachments.setForeign`, on the process's registry. */
export function setForeign(paneId: string, on: boolean): void {
  processAttachments.setForeign(paneId, on);
}

/** `PtyAttachments.releaseViewer`, on the process's registry. */
export function releaseViewer(connectionId: string): void {
  processAttachments.releaseViewer(connectionId);
}

/** Forget everything. Tests only — a real main process never wants this. */
export function resetAttachments(): void {
  processAttachments.reset();
}
