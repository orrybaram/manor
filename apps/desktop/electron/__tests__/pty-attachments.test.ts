/**
 * Who owns a session's winsize.
 *
 * The registry is a handful of lines of bookkeeping and two questions — "is
 * a window on this machine attached" and "who owns it" — and the cases that
 * matter are the ones where the answer outlives the truth: a window that
 * closed without unmounting its panes, two windows holding the same pane, two
 * browsers doing the same with nobody's desktop in the picture, and — since
 * a viewer became a connection — the two windows being told apart from
 * each other rather than lumped together as "the desktop".
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  FOREIGN_CONNECTION_ID,
  PtyAttachments,
  attach,
  claim,
  isHeld,
  reclaimOnInput,
  release,
  releaseViewer,
  onAttachmentChange,
  ownerOf,
  resetAttachments,
  setForeign,
  wouldOwn,
  type Viewer,
} from "../pty-attachments";

/** A renderer window's connection id is its `webContents.id`, as a string. */
const windowA: Viewer = { connectionId: "11", callerClass: "local" };
const windowB: Viewer = { connectionId: "22", callerClass: "local" };

const deviceA: Viewer = { connectionId: "device-a", callerClass: "device" };
const deviceB: Viewer = { connectionId: "device-b", callerClass: "device" };
/** The desktop on a host server's owner channel. */
const ownerChannel: Viewer = { connectionId: "desktop", callerClass: "owner" };
/** A desktop window's own viewer stream to a host server. */
const deskViewer: Viewer = {
  connectionId: "desk-viewer",
  callerClass: "owner",
  viewer: "desktop",
};

/** The panes `run` changed the owner of, as `onAttachmentChange` hears them. */
function changedBy(run: () => void): string[] {
  const seen: string[] = [];
  const unsubscribe = onAttachmentChange((paneId) => seen.push(paneId));
  try {
    run();
  } finally {
    unsubscribe();
  }
  return seen;
}

/** Is a window on this machine holding the pane (and so its owner)? */
function isDesktopAttached(paneId: string): boolean {
  return ownerOf(paneId)?.callerClass === "local";
}

describe("pty attachments", () => {
  beforeEach(() => {
    resetAttachments();
  });

  it("says no about a pane nobody has", () => {
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  it("says yes once a desktop window has it", () => {
    attach("pane-a", windowA);
    expect(isDesktopAttached("pane-a")).toBe(true);
    expect(isDesktopAttached("pane-b")).toBe(false);
  });

  it("releases what a window let go", () => {
    attach("pane-a", windowA);
    release("pane-a", windowA);
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  it("ignores a release from a window that never held it", () => {
    attach("pane-a", windowA);
    release("pane-a", windowB);
    expect(isDesktopAttached("pane-a")).toBe(true);
  });

  /**
   * The case a plain `Set<paneId>` gets wrong. A pane open in the primary
   * window and in a detached one is still the desktop's after either
   * closes, and a browser told otherwise would start resizing a live pane.
   */
  it("keeps a pane two windows hold until both let go", () => {
    attach("pane-a", windowA);
    attach("pane-a", windowB);
    release("pane-a", windowA);
    expect(isDesktopAttached("pane-a")).toBe(true);
    release("pane-a", windowB);
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  it("counts the same window attaching twice as once", () => {
    attach("pane-a", windowA);
    attach("pane-a", windowA);
    release("pane-a", windowA);
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  describe("window death", () => {
    it("drops every pane the dead window held, and only those", () => {
      attach("pane-a", windowA);
      attach("pane-b", windowA);
      attach("pane-c", windowB);

      releaseViewer(windowA.connectionId);

      expect(isDesktopAttached("pane-a")).toBe(false);
      expect(isDesktopAttached("pane-b")).toBe(false);
      expect(isDesktopAttached("pane-c")).toBe(true);
    });

    it("leaves a shared pane owned by the window that is still alive", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);

      releaseViewer(windowA.connectionId);

      expect(isDesktopAttached("pane-a")).toBe(true);
      expect(ownerOf("pane-a")).toEqual(windowB);
    });

    it("is a no-op for a window that held nothing", () => {
      attach("pane-a", windowA);
      releaseViewer(windowB.connectionId);
      expect(isDesktopAttached("pane-a")).toBe(true);
    });
  });

  describe("ownership", () => {
    it("says nobody owns a pane nobody has", () => {
      expect(ownerOf("pane-a")).toBeNull();
    });

    it("makes the one device viewer the owner", () => {
      attach("pane-a", deviceA);
      expect(ownerOf("pane-a")).toEqual(deviceA);
    });

    it("hands ownership to the most recently attached device viewer", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deviceB);
      expect(ownerOf("pane-a")).toEqual(deviceB);
    });

    it("does not move ownership when the same device viewer re-attaches", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deviceB);
      attach("pane-a", deviceA);
      expect(ownerOf("pane-a")).toEqual(deviceB);
    });

    it("falls back to the next most recent device viewer when the owner leaves", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deviceB);
      release("pane-a", deviceB);
      expect(ownerOf("pane-a")).toEqual(deviceA);
    });

    it("gives ownership to a local viewer over any device viewer", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deviceB);
      attach("pane-a", windowA);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("returns ownership to the most recent device viewer once the window lets go", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deviceB);
      attach("pane-a", windowA);
      release("pane-a", windowA);
      expect(ownerOf("pane-a")).toEqual(deviceB);
    });

    /**
     * Why a viewer had to stop being
     * `{kind:"desktop"}`. Two windows on one pane were previously *both* the
     * desktop, so both measured the pane and both resized the session — the
     * winsize fight between owner and follower, seen from the other side.
     * Most-recent-wins applies between equals whatever class they are, so
     * the second window takes the winsize and the first is told it is a
     * follower.
     */
    it("hands ownership to the most recently attached window", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      expect(ownerOf("pane-a")).toEqual(windowB);
    });

    it("gives the winsize back to the first window when the second closes", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      releaseViewer(windowB.connectionId);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    /**
     * A remount is not an arrival. A pane re-created by the window that never
     * let it go must not take the winsize back off the window that did claim
     * it, or a React StrictMode double-mount would be a resize.
     */
    it("does not move ownership when the same window re-attaches", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      attach("pane-a", windowA);
      expect(ownerOf("pane-a")).toEqual(windowB);
    });

    /**
     * What a create-shaped call asks before it runs: may this caller's
     * `cols×rows` reach the pty, or is it a follower being handed the owner's
     * grid to render? (`createShaped` in `bridge/handlers/pty.ts`.)
     */
    describe("wouldOwn", () => {
      it("says yes about a pane nobody has", () => {
        expect(wouldOwn("pane-a", deviceA)).toBe(true);
      });

      it("says yes to a window, whoever is watching", () => {
        attach("pane-a", deviceA);
        attach("pane-a", windowA);
        expect(wouldOwn("pane-a", windowB)).toBe(true);
      });

      it("says yes to a device when only devices are watching", () => {
        attach("pane-a", deviceA);
        expect(wouldOwn("pane-a", deviceB)).toBe(true);
      });

      it("says no to a device when a window has the pane", () => {
        attach("pane-a", windowA);
        expect(wouldOwn("pane-a", deviceA)).toBe(false);
      });

      it("says yes to the viewer that already owns it", () => {
        attach("pane-a", windowA);
        expect(wouldOwn("pane-a", windowA)).toBe(true);
      });

      /**
       * The remount. A window that is already a follower re-creating the pane
       * it never let go of must stay one: its attach moves no ownership, so
       * answering yes here would let a remount resize the owner's session —
       * a follower resizing the owner's pane, arriving through a door marked
       * "reattach".
       */
      it("says no to a viewer that already holds the pane and is not the owner", () => {
        attach("pane-a", windowA);
        attach("pane-a", windowB);
        expect(wouldOwn("pane-a", windowA)).toBe(false);
      });
    });

    describe("change detection", () => {
      it("reports the pane changed the first time a viewer attaches", () => {
        expect(changedBy(() => attach("pane-a", deviceA))).toEqual(["pane-a"]);
      });

      it("reports no change when the new owner is the same as the old", () => {
        attach("pane-a", deviceA);
        expect(changedBy(() => attach("pane-a", deviceA))).toEqual([]);
      });

      it("reports a change when a second device viewer takes over", () => {
        attach("pane-a", deviceA);
        expect(changedBy(() => attach("pane-a", deviceB))).toEqual(["pane-a"]);
      });

      it("reports a change when a second window joins the first", () => {
        attach("pane-a", windowA);
        expect(changedBy(() => attach("pane-a", windowB))).toEqual(["pane-a"]);
      });

      it("reports a change when the owning device viewer releases", () => {
        attach("pane-a", deviceA);
        expect(changedBy(() => release("pane-a", deviceA))).toEqual(["pane-a"]);
      });

      it("reports no change when a non-owning device viewer releases", () => {
        attach("pane-a", deviceA);
        attach("pane-a", deviceB);
        expect(changedBy(() => release("pane-a", deviceA))).toEqual([]);
      });

      it("reports every pane whose owner changed when a connection drops", () => {
        attach("pane-a", deviceA);
        attach("pane-b", deviceB);
        attach("pane-b", deviceA);
        expect(changedBy(() => releaseViewer("device-a")).sort()).toEqual([
          "pane-a",
          "pane-b",
        ]);
        expect(ownerOf("pane-a")).toBeNull();
        expect(ownerOf("pane-b")).toEqual(deviceB);
      });

      it("tells subscribers which pane changed", () => {
        const seen: string[] = [];
        const unsubscribe = onAttachmentChange((paneId) => seen.push(paneId));
        attach("pane-a", deviceA);
        attach("pane-a", deviceB);
        attach("pane-a", deviceB); // no-op: already the owner
        unsubscribe();
        attach("pane-a", { connectionId: "device-c", callerClass: "device" });
        expect(seen).toEqual(["pane-a", "pane-a"]);
      });
    });
  });

  describe("an explicit claim", () => {
    beforeEach(() => resetAttachments());

    it("lets a window take a pane another window owns, and tells subscribers", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      expect(ownerOf("pane-a")).toEqual(windowB);
      expect(changedBy(() => expect(claim("pane-a", windowA)).toBe(true))).toEqual(["pane-a"]);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("is refused to a device, so a phone never resizes the desk's terminal", () => {
      attach("pane-a", windowA);
      attach("pane-a", deviceA);
      expect(changedBy(() => expect(claim("pane-a", deviceA)).toBe(false))).toEqual([]);
      expect(ownerOf("pane-a")).toEqual(windowA);
      resetAttachments();
      attach("pane-a", ownerChannel);
      attach("pane-a", deviceA);
      expect(claim("pane-a", deviceA)).toBe(false);
      expect(ownerOf("pane-a")).toEqual(ownerChannel);
    });

    it("is refused to a viewer that does not hold the pane", () => {
      attach("pane-a", windowA);
      expect(claim("pane-a", deviceA)).toBe(false);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("ends when the desk types, but not when the claimant does", () => {
      attach("pane-a", windowA);
      attach("pane-a", ownerChannel);
      claim("pane-a", ownerChannel);
      reclaimOnInput("pane-a", ownerChannel);
      expect(ownerOf("pane-a")).toEqual(ownerChannel);
      expect(changedBy(() => reclaimOnInput("pane-a", windowA))).toEqual(["pane-a"]);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("ends when the claimant lets go or drops", () => {
      attach("pane-a", windowA);
      attach("pane-a", ownerChannel);
      claim("pane-a", ownerChannel);
      release("pane-a", ownerChannel);
      expect(ownerOf("pane-a")).toEqual(windowA);
      attach("pane-a", ownerChannel);
      claim("pane-a", ownerChannel);
      releaseViewer(ownerChannel.connectionId);
      expect(ownerOf("pane-a")).toEqual(windowA);
      // A fresh attach of the same viewer is not still claiming.
      attach("pane-a", ownerChannel);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("gives way to a new arrival, decided by the default rules", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      claim("pane-a", windowA);
      attach("pane-a", deviceA);
      expect(ownerOf("pane-a")).toEqual(windowB);
    });

    it("moves to whoever claimed last", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      attach("pane-a", ownerChannel);
      claim("pane-a", ownerChannel);
      claim("pane-a", windowA);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });
  });

  describe("the owner channel", () => {
    it("ranks below a window on this machine and above a device", () => {
      attach("pane-a", windowA);
      expect(wouldOwn("pane-a", ownerChannel)).toBe(false);
      attach("pane-a", ownerChannel);
      expect(ownerOf("pane-a")).toEqual(windowA);

      resetAttachments();
      attach("pane-a", deviceA);
      expect(wouldOwn("pane-a", ownerChannel)).toBe(true);
      attach("pane-a", ownerChannel);
      expect(ownerOf("pane-a")).toEqual(ownerChannel);
      expect(wouldOwn("pane-a", deviceB)).toBe(false);
      attach("pane-a", deviceB);
      expect(ownerOf("pane-a")).toEqual(ownerChannel);
    });
  });

  describe("a desktop viewer stream", () => {
    it("outranks a device, whichever attached first", () => {
      attach("pane-a", deviceA);
      expect(wouldOwn("pane-a", deskViewer)).toBe(true);
      expect(changedBy(() => attach("pane-a", deskViewer))).toEqual(["pane-a"]);
      expect(ownerOf("pane-a")).toEqual(deskViewer);
      // A device arriving later follows.
      expect(wouldOwn("pane-a", deviceB)).toBe(false);
      attach("pane-a", deviceB);
      expect(ownerOf("pane-a")).toEqual(deskViewer);
    });

    it("outranks main's owner channel", () => {
      attach("pane-a", deskViewer);
      expect(wouldOwn("pane-a", ownerChannel)).toBe(false);
      attach("pane-a", ownerChannel);
      expect(ownerOf("pane-a")).toEqual(deskViewer);
    });

    it("leaves a device the owner while no viewer has the pane mounted", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deskViewer);
      expect(changedBy(() => release("pane-a", deskViewer))).toEqual(["pane-a"]);
      expect(ownerOf("pane-a")).toEqual(deviceA);
      attach("pane-b", deviceB);
      expect(ownerOf("pane-b")).toEqual(deviceB);
    });

    it("takes the winsize back from another claim by typing, as a desk window does", () => {
      attach("pane-a", deskViewer);
      attach("pane-a", ownerChannel);
      expect(claim("pane-a", ownerChannel)).toBe(true);
      expect(ownerOf("pane-a")).toEqual(ownerChannel);
      reclaimOnInput("pane-a", deskViewer);
      expect(ownerOf("pane-a")).toEqual(deskViewer);
    });

    it("still follows a foreign hold", () => {
      attach("pane-a", deskViewer);
      setForeign("pane-a", true);
      expect(ownerOf("pane-a")?.connectionId).toBe(FOREIGN_CONNECTION_ID);
      expect(wouldOwn("pane-a", deskViewer)).toBe(false);
    });
  });

  describe("a foreign hold", () => {
    it("owns the pane while set, and hands it back to the default rules", () => {
      attach("pane-a", deviceA);
      expect(changedBy(() => setForeign("pane-a", true))).toEqual(["pane-a"]);
      expect(ownerOf("pane-a")?.connectionId).toBe(FOREIGN_CONNECTION_ID);
      expect(isHeld("pane-a")).toBe(true);
      // Setting it again moves nothing.
      expect(changedBy(() => setForeign("pane-a", true))).toEqual([]);
      expect(changedBy(() => setForeign("pane-a", false))).toEqual(["pane-a"]);
      expect(ownerOf("pane-a")).toEqual(deviceA);
    });

    it("makes every arrival a follower, even before anyone here holds the pane", () => {
      setForeign("pane-a", true);
      expect(wouldOwn("pane-a", deviceA)).toBe(false);
      expect(wouldOwn("pane-a", windowA)).toBe(false);
      expect(isHeld("pane-a")).toBe(false);
      attach("pane-a", deviceA);
      expect(ownerOf("pane-a")?.connectionId).toBe(FOREIGN_CONNECTION_ID);
    });

    it("beats a claim, and a claim made during it is refused", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      claim("pane-a", windowA);
      setForeign("pane-a", true);
      expect(claim("pane-a", windowB)).toBe(false);
      expect(ownerOf("pane-a")?.connectionId).toBe(FOREIGN_CONNECTION_ID);
      // The earlier claim survives the hold.
      setForeign("pane-a", false);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("is forgotten by resetAttachments", () => {
      setForeign("pane-a", true);
      resetAttachments();
      expect(ownerOf("pane-a")).toBeNull();
    });
  });

  /** A viewer coming back after its connection dropped. */
  describe("attaching as a returning viewer", () => {
    const returning = { as: "returning" } as const;

    it("does not take the winsize off a viewer that attached meanwhile", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deviceB);
      releaseViewer(deviceA.connectionId);
      expect(changedBy(() => attach("pane-a", deviceA, returning))).toEqual([]);
      expect(ownerOf("pane-a")).toEqual(deviceB);
    });

    it("leaves a standing claim standing", () => {
      attach("pane-a", windowA);
      attach("pane-a", windowB);
      claim("pane-a", windowA);
      attach("pane-a", ownerChannel, returning);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("still lets a window outrank a device", () => {
      attach("pane-a", deviceA);
      attach("pane-a", windowA, returning);
      expect(ownerOf("pane-a")).toEqual(windowA);
    });

    it("owns a pane nobody else has", () => {
      expect(changedBy(() => attach("pane-a", deviceA, returning))).toEqual(["pane-a"]);
      expect(ownerOf("pane-a")).toEqual(deviceA);
    });

    it("leaves a viewer that never let go where it was", () => {
      attach("pane-a", deviceA);
      attach("pane-a", deviceB);
      attach("pane-a", deviceA, returning);
      expect(ownerOf("pane-a")).toEqual(deviceB);
      release("pane-a", deviceB);
      expect(ownerOf("pane-a")).toEqual(deviceA);
    });
  });
});

describe("a registry of its own", () => {
  beforeEach(() => resetAttachments());

  it("lists who holds a pane, oldest first", () => {
    const own = new PtyAttachments();
    own.attach("pane-a", deviceA);
    own.attach("pane-a", windowA);
    expect(own.viewersOf("pane-a")).toEqual([deviceA, windowA]);
    own.release("pane-a", deviceA);
    expect(own.viewersOf("pane-a")).toEqual([windowA]);
    expect(own.viewersOf("pane-b")).toEqual([]);
  });

  it("is apart from the process's: its holders, claims and sinks are its own", () => {
    const own = new PtyAttachments();
    const heard: string[] = [];
    own.onAttachmentChange((paneId) => heard.push(paneId));
    attach("pane-a", windowA);
    expect(heard).toEqual([]);
    own.attach("pane-a", deviceA);
    expect(heard).toEqual(["pane-a"]);
    expect(ownerOf("pane-a")).toEqual(windowA);
    expect(own.ownerOf("pane-a")).toEqual(deviceA);
    own.releaseViewer(deviceA.connectionId);
    expect(own.isHeld("pane-a")).toBe(false);
    expect(isHeld("pane-a")).toBe(true);
  });
});
