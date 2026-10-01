/**
 * Who owns a session's winsize (ADR-178 D5, ADR-179 D6).
 *
 * The registry is a handful of lines of bookkeeping and two questions — "is
 * the desktop attached" and "who owns it" — and the cases that matter are the
 * ones where the answer outlives the truth: a window that closed without
 * unmounting its panes, two windows holding the same pane, and now two
 * browsers doing the same with nobody's desktop in the picture.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  attach,
  release,
  releaseViewer,
  isDesktopAttached,
  onAttachmentChange,
  ownerOf,
  resetAttachments,
  type Viewer,
} from "../pty-attachments";

const WINDOW_A = 11;
const WINDOW_B = 22;

const bridgeA: Viewer = { kind: "bridge", id: "bridge-a" };
const bridgeB: Viewer = { kind: "bridge", id: "bridge-b" };
const desktopA: Viewer = { kind: "desktop", id: WINDOW_A };

describe("pty attachments", () => {
  beforeEach(() => {
    resetAttachments();
  });

  it("says no about a pane nobody has", () => {
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  it("says yes once a desktop window has it", () => {
    attach("pane-a", WINDOW_A);
    expect(isDesktopAttached("pane-a")).toBe(true);
    expect(isDesktopAttached("pane-b")).toBe(false);
  });

  it("releases what a window let go", () => {
    attach("pane-a", WINDOW_A);
    release("pane-a", WINDOW_A);
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  it("ignores a release from a window that never held it", () => {
    attach("pane-a", WINDOW_A);
    release("pane-a", WINDOW_B);
    expect(isDesktopAttached("pane-a")).toBe(true);
  });

  /**
   * The case a plain `Set<paneId>` gets wrong. A pane open in the primary
   * window and in a detached one (ADR-156) is still the desktop's after either
   * closes, and a browser told otherwise would start resizing a live pane.
   */
  it("keeps a pane two windows hold until both let go", () => {
    attach("pane-a", WINDOW_A);
    attach("pane-a", WINDOW_B);
    release("pane-a", WINDOW_A);
    expect(isDesktopAttached("pane-a")).toBe(true);
    release("pane-a", WINDOW_B);
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  it("counts the same window attaching twice as once", () => {
    attach("pane-a", WINDOW_A);
    attach("pane-a", WINDOW_A);
    release("pane-a", WINDOW_A);
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  it("releases a pane outright when no window is named", () => {
    attach("pane-a", WINDOW_A);
    attach("pane-a", WINDOW_B);
    release("pane-a");
    expect(isDesktopAttached("pane-a")).toBe(false);
  });

  describe("window death", () => {
    it("drops every pane the dead window held, and only those", () => {
      attach("pane-a", WINDOW_A);
      attach("pane-b", WINDOW_A);
      attach("pane-c", WINDOW_B);

      releaseViewer(WINDOW_A);

      expect(isDesktopAttached("pane-a")).toBe(false);
      expect(isDesktopAttached("pane-b")).toBe(false);
      expect(isDesktopAttached("pane-c")).toBe(true);
    });

    it("leaves a shared pane owned by the window that is still alive", () => {
      attach("pane-a", WINDOW_A);
      attach("pane-a", WINDOW_B);

      releaseViewer(WINDOW_A);

      expect(isDesktopAttached("pane-a")).toBe(true);
    });

    it("is a no-op for a window that held nothing", () => {
      attach("pane-a", WINDOW_A);
      releaseViewer(WINDOW_B);
      expect(isDesktopAttached("pane-a")).toBe(true);
    });
  });

  describe("ownership (D6)", () => {
    it("says nobody owns a pane nobody has", () => {
      expect(ownerOf("pane-a")).toBeNull();
    });

    it("makes the one bridge viewer the owner", () => {
      attach("pane-a", bridgeA);
      expect(ownerOf("pane-a")).toEqual(bridgeA);
    });

    it("hands ownership to the most recently attached bridge viewer", () => {
      attach("pane-a", bridgeA);
      attach("pane-a", bridgeB);
      expect(ownerOf("pane-a")).toEqual(bridgeB);
    });

    it("does not move ownership when the same bridge viewer re-attaches", () => {
      attach("pane-a", bridgeA);
      attach("pane-a", bridgeB);
      attach("pane-a", bridgeA);
      expect(ownerOf("pane-a")).toEqual(bridgeB);
    });

    it("falls back to the next most recent bridge viewer when the owner leaves", () => {
      attach("pane-a", bridgeA);
      attach("pane-a", bridgeB);
      release("pane-a", bridgeB);
      expect(ownerOf("pane-a")).toEqual(bridgeA);
    });

    it("gives ownership to a desktop viewer over any bridge viewer", () => {
      attach("pane-a", bridgeA);
      attach("pane-a", bridgeB);
      attach("pane-a", desktopA);
      expect(ownerOf("pane-a")).toEqual(desktopA);
    });

    it("returns ownership to the most recent bridge viewer once the desktop lets go", () => {
      attach("pane-a", bridgeA);
      attach("pane-a", bridgeB);
      attach("pane-a", desktopA);
      release("pane-a", desktopA);
      expect(ownerOf("pane-a")).toEqual(bridgeB);
    });

    describe("change detection", () => {
      it("reports the pane changed the first time a viewer attaches", () => {
        expect(attach("pane-a", bridgeA).changed).toEqual(["pane-a"]);
      });

      it("reports no change when the new owner is the same as the old", () => {
        attach("pane-a", bridgeA);
        expect(attach("pane-a", bridgeA).changed).toEqual([]);
      });

      it("reports a change when a second bridge viewer takes over", () => {
        attach("pane-a", bridgeA);
        expect(attach("pane-a", bridgeB).changed).toEqual(["pane-a"]);
      });

      it("reports no change when a second desktop window joins the first", () => {
        attach("pane-a", desktopA);
        expect(attach("pane-a", { kind: "desktop", id: WINDOW_B }).changed).toEqual(
          [],
        );
      });

      it("reports a change when the owning bridge viewer releases", () => {
        attach("pane-a", bridgeA);
        expect(release("pane-a", bridgeA).changed).toEqual(["pane-a"]);
      });

      it("reports no change when a non-owning bridge viewer releases", () => {
        attach("pane-a", bridgeA);
        attach("pane-a", bridgeB);
        expect(release("pane-a", bridgeA).changed).toEqual([]);
      });

      it("reports every pane whose owner changed when a bridge connection drops", () => {
        attach("pane-a", bridgeA);
        attach("pane-b", bridgeB);
        attach("pane-b", bridgeA);
        expect(releaseViewer("bridge-a", "bridge").changed.sort()).toEqual([
          "pane-a",
          "pane-b",
        ]);
        expect(ownerOf("pane-a")).toBeNull();
        expect(ownerOf("pane-b")).toEqual(bridgeB);
      });

      it("tells subscribers which pane changed", () => {
        const seen: string[] = [];
        const unsubscribe = onAttachmentChange((paneId) => seen.push(paneId));
        attach("pane-a", bridgeA);
        attach("pane-a", bridgeB);
        attach("pane-a", bridgeB); // no-op: already the owner
        unsubscribe();
        attach("pane-a", { kind: "bridge", id: "bridge-c" });
        expect(seen).toEqual(["pane-a", "pane-a"]);
      });
    });
  });
});
