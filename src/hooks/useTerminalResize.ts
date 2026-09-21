/**
 * useOwnerFit / useFollowerFit — ResizeObserver + fit addon for auto-fitting
 * a terminal.
 *
 * Two hooks, not one with a branch inside it (ADR-182 ticket 1): a winsize
 * owner measures the pane and tells the pty; a follower fits the pane to a
 * grid it never moves, shrinking its font toward {@link FONT_FLOOR} instead.
 * `useTerminalLifecycle` calls both, unconditionally, each behind its own
 * `enabled` — the ownership flip is `enabled` moving from one to the other,
 * and a hook that stops being enabled cleans up after itself, which is what
 * lets `useFollowerFit` restore the font it shrank (see its own comment).
 *
 * Neither hook resizes the terminal's *grid*: that is driven from the output
 * stream, in `useTerminalStream`, at the position the daemon marks when the
 * ioctl lands.
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

/**
 * Below this nobody reads anything — the pane pans sideways instead.
 *
 * ADR-177's floor, measured on a phone and reused here because the rule is the
 * same rule: a viewer that may not move the grid scales the glyphs until the
 * grid fits, and then stops scaling.
 */
export const FONT_FLOOR = 6;

/**
 * The font size at which `cols` columns fit `available` pixels.
 *
 * Pure, because it is the whole of follower mode's geometry and the rest of
 * that path is DOM. `cellWidth` is what one column costs at `currentSize`, so
 * the advance per point is `cellWidth / currentSize` and the answer is the
 * available width divided by it, floored — a fractional font size measures to a
 * fractional cell and lands the last column a pixel outside the pane.
 *
 * `ceiling` is the pane's *configured* size, not a constant: at full width a
 * follower must render exactly as the desktop does, so the only direction this
 * moves is down. Between the ceiling and the floor the grid fits; at the floor
 * it does not, and the container scrolls.
 */
export function followerFontSize(
  currentSize: number,
  available: number,
  cols: number,
  cellWidth: number,
  ceiling: number,
): number {
  if (!(currentSize > 0) || !(available > 0)) return ceiling;
  if (!(cols > 0) || !(cellWidth > 0)) return ceiling;
  const ideal = Math.floor((currentSize * available) / (cols * cellWidth));
  return Math.min(ceiling, Math.max(FONT_FLOOR, ideal));
}

/**
 * What one column costs, in CSS pixels, at the terminal's current font size.
 *
 * xterm's own measurement is preferred over a probe of our own: it is the
 * number the renderer is actually laying columns out with, including whatever
 * the font stack fell back to. The DOM measure element is the public-ish one —
 * `'W'.repeat(n)` in a `pre` span, sized to the terminal's options — but it
 * only exists when the DOM measure strategy is in use, and the width-cache
 * spans that share its class are not it (their contents change mid-measure).
 * The render service's cell width is the same figure, reached through an
 * internal, and is the fallback rather than the source for that reason.
 */
export function measureCellWidth(term: Terminal): number | null {
  const probes = term.element?.querySelectorAll<HTMLElement>(
    ".xterm-char-measure-element",
  );
  for (const probe of probes ?? []) {
    if (
      probe.parentElement?.classList.contains(
        "xterm-width-cache-measure-container",
      )
    ) {
      continue;
    }
    const chars = probe.textContent?.length ?? 0;
    if (chars === 0) continue;
    const width = probe.getBoundingClientRect().width / chars;
    if (width > 0) return width;
  }

  const css = (
    term as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } };
      };
    }
  )._core?._renderService?.dimensions?.css?.cell?.width;
  return typeof css === "number" && css > 0 ? css : null;
}

/**
 * The winsize owner's half of D5: measure the pane, tell the pty.
 *
 * `enabled` is false for exactly as long as this viewer is a follower — see
 * the file header. Disabled, the hook does nothing at all; it neither
 * measures nor keeps a stale `lastSentRef` around; that ref is reset every
 * time the effect (re)starts, so a size sent in a previous span of ownership
 * is never mistaken for one sent in this one.
 */
export function useOwnerFit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  fitAddon: FitAddon | null,
  term: Terminal | null,
  resizePty: (cols: number, rows: number) => Promise<void>,
  enabled: boolean,
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
    if (!enabled) return;
    const container = containerRef.current;
    if (!container || !fitAddon) return;

    // A new terminal has been sent nothing.
    lastSentRef.current = null;

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

    let observerFrame = 0;
    let refitFrame = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;

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
  }, [containerRef, fitAddon, term, enabled]);
}

/**
 * The follower's half of D5: fit the *pane* to the owner's grid, never the
 * other way around.
 *
 * Scaling the glyphs rather than reflowing the text, for ADR-177's reason: an
 * agent draws box borders and diff gutters at a width it was told, and a
 * viewer that re-wraps them to its own width breaks every one of them. So the
 * grid stays exactly as the owner left it, the font shrinks until it fits,
 * and below {@link FONT_FLOOR} the container pans sideways instead.
 *
 * `target` is null exactly when `enabled` is false, so the effect below never
 * runs without one.
 *
 * **The font is a loan, not a rename (regression 6).** `configuredFontSizeRef`
 * is captured once per span of `enabled` — guarded by `=== null`, so a grid
 * change partway through a follower session re-fits without recapturing an
 * already-shrunk size — and the cleanup below always undoes the shrink and
 * forgets the ceiling again, whether the reason is the grid moving, this
 * viewer becoming the owner, or the pane unmounting. That makes every capture
 * fresh: by the time the next one happens, the previous cleanup has already
 * put `term.options.fontSize` back, so there is no stale preference to miss.
 */
export function useFollowerFit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  term: Terminal | null,
  target: Dimensions | null,
  enabled: boolean,
) {
  /**
   * The grid to render. Reset every time the effect (re)starts and moved by
   * the stream from then on: when the owner resizes, `useTerminalStream`
   * applies it to the emulator (ADR-164) and the `onResize` below reads the
   * new grid back out, without waiting for `target` itself to change.
   */
  const targetRef = useRef<Dimensions | null>(target);
  const configuredFontSizeRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !term || !target) return;
    const container = containerRef.current;
    if (!container) return;

    targetRef.current = target;
    if (configuredFontSizeRef.current === null) {
      configuredFontSizeRef.current = term.options.fontSize ?? null;
    }

    let observerFrame = 0;
    let refitFrame = 0;
    let fontFrame = 0;

    const fitFollower = (converge = true) => {
      const el = containerRef.current;
      const t = targetRef.current;
      if (!el || !t) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) return;

      const ceiling =
        configuredFontSizeRef.current ?? term.options.fontSize ?? FONT_FLOOR;
      const current = term.options.fontSize ?? ceiling;
      const cell = measureCellWidth(term);
      if (cell !== null) {
        const size = followerFontSize(
          current,
          el.clientWidth,
          t.cols,
          cell,
          ceiling,
        );
        if (size !== current) {
          term.options.fontSize = size;
          // A font's advance is rounded to device pixels, so a cell is not
          // exactly proportional to its size and one pass can land a hair
          // wide. Re-measuring once against the size that now exists settles
          // it; the maths is a fixed point, so the second pass is a no-op
          // whenever the first was right.
          if (converge) {
            if (fontFrame) cancelAnimationFrame(fontFrame);
            fontFrame = requestAnimationFrame(() => {
              fontFrame = 0;
              fitFollower(false);
            });
          }
        }
      }
      if (term.cols !== t.cols || term.rows !== t.rows) {
        try {
          term.resize(t.cols, t.rows);
        } catch (e) {
          console.error("follower grid resize failed", e);
        }
      }
    };

    fitFollower();

    const observer = new ResizeObserver(() => {
      if (observerFrame) cancelAnimationFrame(observerFrame);
      observerFrame = requestAnimationFrame(() => {
        observerFrame = 0;
        // Nothing leaves this machine, so there is no cost to settle for, and
        // a font that lags the drag by the owner's 400ms reads as a bug.
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitFollower();
      });
    });
    observer.observe(container);

    // The grid moving means the owner moved it and `useTerminalStream`
    // applied it (ADR-178 D5) — so the new grid is the thing to fit to, never
    // evidence to measure and send back. Sending it back would be a loop with
    // a pty in it: this viewer would tell the daemon the size it was just
    // told, and take the desktop's pane with it.
    const grid = term.onResize(() => {
      targetRef.current = { cols: term.cols, rows: term.rows };
      if (refitFrame) cancelAnimationFrame(refitFrame);
      refitFrame = requestAnimationFrame(() => {
        refitFrame = 0;
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitFollower();
      });
    });

    return () => {
      if (observerFrame) cancelAnimationFrame(observerFrame);
      if (refitFrame) cancelAnimationFrame(refitFrame);
      if (fontFrame) cancelAnimationFrame(fontFrame);
      observer.disconnect();
      grid.dispose();
      // Undo the shrink and forget the ceiling, so the next follower session
      // — another grid change, or this viewer losing ownership again later —
      // captures it fresh rather than reusing one from long before
      // (regression 6: a follower used to keep its shrunk font forever).
      if (configuredFontSizeRef.current !== null) {
        term.options.fontSize = configuredFontSizeRef.current;
      }
      configuredFontSizeRef.current = null;
    };
  }, [containerRef, term, target, enabled]);
}
