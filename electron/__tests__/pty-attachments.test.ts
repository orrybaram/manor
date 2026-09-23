/**
 * Who owns a session's winsize (ADR-178 D5, ADR-179 D6, ADR-180 D6).
 *
 * The registry is a handful of lines of bookkeeping and two questions — "is
 * a window on this machine attached" and "who owns it" — and the cases that
 * matter are the ones where the answer outlives the truth: a window that
 * closed without unmounting its panes, two windows holding the same pane, two
 * browsers doing the same with nobody's desktop in the picture, and — since
 * ADR-180 made a viewer a connection — the two windows being told apart from
 * each other rather than lumped together as "the desktop".
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  attach,
  release,
  releaseViewer,
  onAttachmentChange,
  ownerOf,
  resetAttachments,
  wouldOwn,
  type Viewer,
} from "../pty-attachments";

/** A renderer window's connection id is its `webContents.id`, as a string. */
const windowA: Viewer = { connectionId: "11", callerClass: "local" };
const windowB: Viewer = { connectionId: "22", callerClass: "local" };

const deviceA: Viewer = { connectionId: "device-a", callerClass: "device" };
const deviceB: Viewer = { connectionId: "device-b", callerClass: "device" };

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
   * window and in a detached one (ADR-156) is still the desktop's after either
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

  describe("ownership (D6)", () => {
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
     * ADR-180 D6's repair, and the reason a viewer had to stop being
     * `{kind:"desktop"}`. Two windows on one pane were previously *both* the
     * desktop, so both measured the pane and both resized the session — the
     * fight ADR-163/164/165 record from the other side. Most-recent-wins
     * applies between equals whatever class they are, so the second window
     * takes the winsize and the first is told it is a follower.
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
       * ADR-163/164/165 arriving through a door marked "reattach".
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
});
