/**
 * Who owns a session's winsize (ADR-178 D5).
 *
 * The registry is three lines of bookkeeping and one question, and the question
 * is the one a browser's `pty.create` is answered from — so the cases that
 * matter are the ones where the answer outlives the truth: a window that closed
 * without unmounting its panes, and two windows holding the same pane.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  attach,
  release,
  releaseViewer,
  isDesktopAttached,
  resetAttachments,
} from "../pty-attachments";

const WINDOW_A = 11;
const WINDOW_B = 22;

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
});
