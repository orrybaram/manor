/**
 * `resizeInStream`'s contract: the resize lands behind the writes that came
 * before it, not on top of them.
 *
 * That is the whole of what the client half of ADR-164 has to get right. The
 * daemon marks the position in the output where the ioctl landed; applying the
 * resize there — rather than whenever the IPC message happens to be delivered —
 * is what keeps the emulator's width and the program's belief about the width
 * referring to the same instant.
 *
 * This drives the shipped function against a real headless emulator. The
 * behavioural regression — a repainting agent frame staying on screen once
 * across a drag — lives in `tests/e2e/output-duplication.spec.ts`, because it
 * needs a real program reacting to a real SIGWINCH: a hand-written stand-in
 * only reproduces whatever its author assumed about how programs repaint,
 * which is exactly how the previous version of this file stayed green through
 * a shipped bug.
 */

import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { resizeInStream } from "../terminal-resize-stream";

function makeTerm(cols: number, rows: number) {
  return new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
}

const flush = (term: Terminal) =>
  new Promise<void>((resolve) => term.write("", () => resolve()));

describe("resizeInStream", () => {
  it("waits for queued writes before resizing", async () => {
    const term = makeTerm(80, 24);
    let colsWhenWritten = 0;

    term.write("x".repeat(100), () => {
      colsWhenWritten = term.cols;
    });
    resizeInStream(term, 40, 24);
    await flush(term);

    // The write's callback ran while the grid was still 80 wide: the resize
    // queued behind it rather than jumping it.
    expect(colsWhenWritten).toBe(80);
    expect(term.cols).toBe(40);
  });

  it("applies the size it was given", async () => {
    const term = makeTerm(80, 24);
    resizeInStream(term, 132, 43);
    await flush(term);
    expect([term.cols, term.rows]).toEqual([132, 43]);
  });

  it("is a no-op when the terminal is already that size", async () => {
    const term = makeTerm(80, 24);
    let resized = 0;
    term.onResize(() => resized++);
    resizeInStream(term, 80, 24);
    await flush(term);
    expect(resized).toBe(0);
  });

  /**
   * A resize that xterm would reject must not reach it. The callback runs
   * inside the write-buffer drain, so a throw there stops every later write
   * from ever being parsed — the pane goes silent and the app looks frozen.
   * That is how one dropped IPC argument turned into a locked-up window.
   */
  it.each([
    ["a missing row count", 100, undefined as unknown as number],
    ["a missing column count", undefined as unknown as number, 30],
    ["a fractional size", 100.5, 30],
    ["a zero dimension", 100, 0],
    ["a negative dimension", -1, 30],
  ])("keeps writing after %s", async (_label, cols, rows) => {
    const term = makeTerm(80, 24);
    resizeInStream(term, cols, rows);

    let wrote = false;
    term.write("still alive\r\n", () => {
      wrote = true;
    });
    await flush(term);

    expect(wrote).toBe(true);
    expect([term.cols, term.rows]).toEqual([80, 24]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "still alive",
    );
  });

  it("orders two resizes with the output between them", async () => {
    const term = makeTerm(80, 24);
    const widths: number[] = [];

    resizeInStream(term, 60, 24);
    term.write("first", () => widths.push(term.cols));
    resizeInStream(term, 100, 24);
    term.write("second", () => widths.push(term.cols));
    await flush(term);

    expect(widths).toEqual([60, 100]);
  });
});
