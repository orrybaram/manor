/**
 * The resize-duplication experiment, in one place.
 *
 * Two harnesses run it: `claude-resize-duplication.spec.ts` drives the real
 * app, and `scripts/resize-duplication-control.ts` drives a *local* terminal
 * — one process, `term.resize()` and `pty.resize()` between two reads, which
 * is the ordering every native emulator has for free. The whole value of the
 * control is being the same experiment, so the prompt, the markers and the
 * counting live here rather than being kept in step by hand.
 *
 * Imported by a plain Node script as well as by Playwright, so nothing here
 * may reach for Playwright or the DOM.
 */

/** Ask for 200 lines of nothing but markers, so every copy is countable. */
export const PROMPT =
  "Output exactly 200 lines and nothing else: line N is ZQ followed by N " +
  "padded to three digits. Start at ZQ001 and end at ZQ200. " +
  "No commentary, no tools, no code blocks.";

/**
 * Every marker except the two the prompt itself names: those are echoed back
 * in the user's message, so they are legitimately on screen twice.
 */
export const MARKERS = Array.from(
  { length: 198 },
  (_, i) => `ZQ${String(i + 2).padStart(3, "0")}`,
);

/**
 * A marker the prompt does not contain, for "the answer has landed".
 *
 * Waiting on ZQ200 waits on the prompt's own echo, which reaches the screen
 * long before Claude answers — a run that waits on it resizes while the model
 * is still thinking and measures nothing. That mistake made the control report
 * zero duplicates for three runs.
 */
export const LAST_MARKER = "ZQ199";

/** A marker from early in the answer, for "the lines are actually flowing". */
export const FIRST_MARKER = "ZQ020";

/**
 * The sizes a recorded drag settled on, and the size it started from.
 *
 * Taken from a real window drag in the app so the control can replay it
 * exactly; holding each one outlasts `SETTLE_MS`, or the sweep coalesces into
 * the single size it ends on.
 */
export const DRAG_START: [number, number] = [127, 41];
export const DRAG_SIZES: Array<[number, number]> = [
  [144, 46],
  [167, 50],
  [144, 46],
  [111, 37],
  [88, 30],
  [111, 37],
  [144, 46],
  [167, 50],
  [144, 46],
  [111, 37],
  [88, 30],
  [111, 37],
  [127, 41],
];

/**
 * What this drag costs in a terminal that manor has nothing to do with.
 *
 * Claude Code repaints its whole screen on `SIGWINCH`, and a terminal that
 * loses rows puts them in the scrollback without taking them back when it
 * regains them — so the repaint draws them a second time. Measured at 15
 * markers by `scripts/resize-duplication-control.ts`, and reproduced
 * independently in Ghostty. It is not manor's to fix, and it is not zero.
 */
const LOCAL_TERMINAL_FLOOR = 15;

/**
 * How far past that floor the app is allowed to be.
 *
 * The distance is the part manor owns; the floor is not. Re-measure the floor
 * with the control script before moving this number.
 */
export const DUPLICATE_CEILING = LOCAL_TERMINAL_FLOOR + 3;

/** Markers on screen more than once, as `ZQ123x3`. */
export function duplicates(text: string): string[] {
  return MARKERS.flatMap((marker) => {
    const seen = text.split(marker).length - 1;
    return seen > 1 ? [`${marker}x${seen}`] : [];
  });
}

/** How many of the markers reached the screen at all. */
export function printed(text: string): number {
  return MARKERS.filter((marker) => text.includes(marker)).length;
}
