/**
 * Applying a resize where it belongs: at its position in the output stream.
 *
 * The daemon marks the point at which the pty's winsize changed — every byte
 * before it was produced at the old size, every byte after at the new one (see
 * ADR-164). An emulator that resizes its grid at that point matches what the
 * program believes it is drawing into; one that resizes a few chunks either
 * side of it does not, and a program repainting a region in place strands a
 * copy of that region every time it repaints across the gap.
 *
 * The mechanism is xterm's write callback: `write("", cb)` runs `cb` behind
 * whatever the terminal has already queued, so the resize lands after those
 * writes rather than jumping them.
 */

/** The part of a terminal this needs — xterm's `Terminal`, headless or not. */
export interface ResizableTerminal {
  readonly cols: number;
  readonly rows: number;
  write(data: string, callback?: () => void): void;
  resize(columns: number, rows: number): void;
  refresh?(start: number, end: number): void;
}

/**
 * Resize `target` behind its pending writes, at the stream's own ordering.
 *
 * Nothing in here may throw. The callback runs inside xterm's write-buffer
 * drain, and an exception there stops that drain for the life of the terminal:
 * no byte written afterwards is ever parsed, so the pane goes silent and the
 * app reads as frozen rather than as having mishandled one resize. A size that
 * is not a usable pair of positive integers is dropped here rather than passed
 * on, because xterm rejects such a pair by throwing — which is the one outcome
 * this function cannot afford.
 */
export function resizeInStream(
  target: ResizableTerminal,
  cols: number,
  rows: number,
): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
  if (cols <= 0 || rows <= 0) return;
  target.write("", () => {
    if (target.cols === cols && target.rows === rows) return;
    try {
      target.resize(cols, rows);
      // Force a full viewport refresh after a resize to fix WebGL renderer
      // glitches where text becomes garbled until the next one.
      target.refresh?.(0, target.rows - 1);
    } catch (e) {
      console.error("terminal grid resize failed", e);
    }
  });
}
