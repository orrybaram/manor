/**
 * useTerminalResize — ResizeObserver + fit addon for auto-fitting a terminal.
 *
 * Measures the pane and tells the pty. It does **not** resize the terminal:
 * the grid is driven from the output stream, in `useTerminalStream`, at the
 * position the daemon marks when the ioctl lands.
 *
 * That split is the point, and it is ADR-164. A resize in a local terminal is
 * one function — set the grid, call `TIOCSWINSZ` — so it sits at a known place
 * between two reads of the pty: bytes before it were drawn at the old size,
 * bytes after at the new one. An inline agent harness repaints by moving the
 * cursor up over the rows it last drew, and that is only correct while the grid
 * and the program agree about the width, which the two halves of one function
 * guarantee for free.
 *
 * Resizing the grid here instead — locally, immediately, while the winsize
 * travels three hops — put those halves on opposite sides of a race, and every
 * rule tried in this file (a ratchet, a settle window, a redraw grace period, a
 * direction-ordered pair) was a guess at where in the stream the other half
 * landed. Measured on recorded drags, the guesses cost 142 and 2296 stranded
 * copies. The daemon knows the answer exactly, so it says so, and this hook
 * stops guessing.
 *
 * Being pure geometry has a second half, and leaving it out is ADR-165: this
 * hook may not read the grid to decide what the pty knows. The grid is the
 * daemon's to move, so a grid that has drifted from the winsize is precisely
 * the case where a resize must be sent — and comparing a measurement against
 * the grid is what stopped it being sent, leaving the pane wrapping at a
 * different width than the program for the rest of the session. Measurements
 * are judged against the last size *sent*; see `shouldSendFit`.
 */

import { useLayoutEffect, useRef } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/**
 * How still the pane must be before its size is sent.
 *
 * Cost, not correctness: with the grid following the stream, a size the pty is
 * told mid-drag cannot strand anything — but it still costs the program a full
 * re-render of its transcript, and a drag produces one per animation frame.
 * The window clears the pauses a hand makes mid-drag rather than the gaps
 * between frames; at 150ms it did not, and a six-second drag sent a dozen
 * sizes instead of one.
 */
const SETTLE_MS = 400;

/** A size, as measured or as sent. */
export interface Dimensions {
  cols: number;
  rows: number;
}

/**
 * Whether a freshly measured size is worth sending to the pty.
 *
 * Measured against the last size *sent*, never against the grid. That is the
 * sentence that keeps this hook honest about being pure geometry: after
 * ADR-164 the grid is driven by the daemon, so it cannot also stand as
 * evidence of what the daemon knows.
 *
 * Reading the grid here is what made a disagreement permanent. A grid that has
 * drifted from the winsize — a lost event, an ack that timed out, a client we
 * have not written yet — is put right by the daemon answering the next resize
 * request, and this is the test that decides whether that request is ever made.
 * Comparing against the grid suppresses exactly the send that would fix it, at
 * exactly the moment it is needed, and the pane then wraps at a different width
 * than the program does for the rest of the session (ADR-165).
 */
export function shouldSendFit(
  proposed: Dimensions | undefined,
  lastSent: Dimensions | null,
): boolean {
  if (!proposed?.cols || !proposed.rows) return false;
  if (!lastSent) return true;
  return proposed.cols !== lastSent.cols || proposed.rows !== lastSent.rows;
}

export function useTerminalResize(
  containerRef: React.RefObject<HTMLDivElement | null>,
  fitAddon: FitAddon | null,
  term: Terminal | null,
  resizePty: (cols: number, rows: number) => Promise<void>,
) {
  /** The last size handed to the pty — what a new measurement is judged against. */
  const lastSentRef = useRef<Dimensions | null>(null);
  /** Kept in a ref so a new `resizePty` identity does not re-run the effect. */
  const resizePtyRef = useRef(resizePty);
  resizePtyRef.current = resizePty;

  /**
   * Attach to the pane, and detach from it, as one thing.
   *
   * A layout effect rather than the render body. Setting up in render meant
   * three side effects on a render React is free to throw away — two live
   * subscriptions and, in `sendFit`, an ioctl on a real process. A discarded
   * render leaves all three behind with nothing tracking them, and a `SIGWINCH`
   * nobody asked for is precisely how the pty gets told a size the pane never
   * was, which is the whole of issue #169.
   *
   * It is also the only teardown. The render-body version needed a second copy
   * in an unmount effect, and the two had already drifted: the unmount copy
   * left `prevFitAddonRef` pointing at the addon it had just detached from, so
   * anything that unmounted effects while keeping refs — React's `Activity`,
   * which is exactly how a hidden pane would want to be modelled — came back
   * with the change check satisfied and never re-attached. No observer, no
   * re-fit, no error.
   *
   * A layout effect is not the "frame later" the old comment was avoiding:
   * `useLayoutEffect` runs after the DOM is mutated and before paint, in the
   * same frame. `useEffect` is the one that waits.
   */
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !fitAddon) return;

    // A new terminal has been sent nothing.
    lastSentRef.current = null;

    let observerFrame = 0;
    let refitFrame = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;

    /** Send the pane's current size, unless it is the size already sent. */
    const sendFit = () => {
      const dims = fitAddon.proposeDimensions();
      if (!dims || !shouldSendFit(dims, lastSentRef.current)) return;
      const next = { cols: dims.cols, rows: dims.rows };
      lastSentRef.current = next;
      void resizePtyRef.current(next.cols, next.rows).catch((e) => {
        console.error("terminal resize failed", e);
      });
    };

    sendFit();

    const observer = new ResizeObserver(() => {
      if (observerFrame) cancelAnimationFrame(observerFrame);
      observerFrame = requestAnimationFrame(() => {
        observerFrame = 0;
        // A hidden pane (collapsed panel, background tab) measures 0×0, and
        // sending that would resize the pty to something meaningless and
        // reflow the buffer for good. Skip until it has a real box again.
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => {
          settle = null;
          sendFit();
        }, SETTLE_MS);
      });
    });
    observer.observe(container);

    /**
     * Re-fit once the grid has actually moved.
     *
     * A fit is measured against the grid as it stands, and xterm re-measures
     * its cell metrics when the grid changes — so the size sent from a single
     * container change can land a few rows off. The container is unchanged by
     * that, which is exactly the problem: the ResizeObserver has nothing left
     * to fire on, so an off-by-a-few fit is the size the pane keeps, sitting
     * taller than its box with its bottom rows clipped for good. Measured at
     * three rows on a single window shrink.
     *
     * Reading the fit here rather than on the container closes that: the fit
     * is re-read against the grid that now exists, and `sendFit` is a no-op
     * once the two agree, so this settles after one extra round trip instead
     * of oscillating.
     */
    const grid =
      term?.onResize(() => {
        if (refitFrame) cancelAnimationFrame(refitFrame);
        refitFrame = requestAnimationFrame(() => {
          refitFrame = 0;
          const el = containerRef.current;
          if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
          sendFit();
        });
      }) ?? null;

    return () => {
      if (observerFrame) cancelAnimationFrame(observerFrame);
      if (refitFrame) cancelAnimationFrame(refitFrame);
      if (settle) clearTimeout(settle);
      observer.disconnect();
      grid?.dispose();
    };
  }, [containerRef, fitAddon, term]);
}
