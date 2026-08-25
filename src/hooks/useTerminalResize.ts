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

import { useRef } from "react";
import { useMountEffect } from "./useMountEffect";
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
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(fitAddon);
  fitAddonRef.current = fitAddon;
  /** The last size handed to the pty — what a new measurement is judged against. */
  const lastSentRef = useRef<Dimensions | null>(null);
  const resizePtyRef = useRef(resizePty);
  resizePtyRef.current = resizePty;
  const prevFitAddonRef = useRef<FitAddon | null>(null);
  const gridRef = useRef<{ dispose(): void } | null>(null);
  const refitRafRef = useRef<number>(0);

  // Render-time setup: when fitAddon changes (null → value) the component
  // re-renders and the observer is set up synchronously, rather than a frame
  // later in an effect. useMountEffect handles teardown on unmount.
  if (fitAddon !== prevFitAddonRef.current) {
    prevFitAddonRef.current = fitAddon;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = null;
    if (refitRafRef.current) cancelAnimationFrame(refitRafRef.current);
    refitRafRef.current = 0;
    observerRef.current?.disconnect();
    observerRef.current = null;
    gridRef.current?.dispose();
    gridRef.current = null;
    // A new terminal has been sent nothing.
    lastSentRef.current = null;

    const container = containerRef.current;
    if (container && fitAddon) {
      /** Send the pane's current size, unless it is the size already sent. */
      const sendFit = () => {
        const dims = fitAddonRef.current?.proposeDimensions();
        if (!dims || !shouldSendFit(dims, lastSentRef.current)) return;
        const next = { cols: dims.cols, rows: dims.rows };
        lastSentRef.current = next;
        void resizePtyRef.current(next.cols, next.rows).catch((e) => {
          console.error("terminal resize failed", e);
        });
      };

      sendFit();

      observerRef.current = new ResizeObserver(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          // A hidden pane (collapsed panel, background tab) measures 0×0, and
          // sending that would resize the pty to something meaningless and
          // reflow the buffer for good. Skip until it has a real box again.
          const el = containerRef.current;
          if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
          if (settleRef.current) clearTimeout(settleRef.current);
          settleRef.current = setTimeout(() => {
            settleRef.current = null;
            sendFit();
          }, SETTLE_MS);
        });
      });
      observerRef.current.observe(container);

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
      gridRef.current = term?.onResize(() => {
        if (refitRafRef.current) cancelAnimationFrame(refitRafRef.current);
        refitRafRef.current = requestAnimationFrame(() => {
          refitRafRef.current = 0;
          const el = containerRef.current;
          if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
          sendFit();
        });
      }) ?? null;
    }
  }

  useMountEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (settleRef.current) clearTimeout(settleRef.current);
      settleRef.current = null;
      if (refitRafRef.current) cancelAnimationFrame(refitRafRef.current);
      refitRafRef.current = 0;
      observerRef.current?.disconnect();
      observerRef.current = null;
      gridRef.current?.dispose();
      gridRef.current = null;
    };
  });
}
