/**
 * useTerminalTouch — what a finger means on a terminal in phone mode
 * (ADR-181 D5, D6).
 *
 * Three gestures, and each means exactly one thing:
 *
 * - A **tap** focuses xterm, which is what raises the soft keyboard. iOS only
 *   raises it for a focus made *synchronously inside the user gesture*, so the
 *   focus happens in the `touchend` listener itself — never after an `await`,
 *   a timer, a frame or a React state update, every one of which runs outside
 *   the gesture and leaves the keyboard down.
 * - A **long-press** opens the pane's context menu. Radix's
 *   `ContextMenu.Trigger` owns that: a 700 ms timer from `pointerdown` that it
 *   cancels on *any* `pointermove`. A real finger never holds still to the
 *   pixel, so left alone the timer rarely survives; the trigger handlers here
 *   swallow the moves that stay inside `TAP_SLOP_PX`, which is Radix's own
 *   documented extension point (`preventDefault` in a consumer handler skips
 *   its internal one). A hold that ends the menu is never also a tap.
 * - A **drag** scrolls — or, for a follower wider than the phone, pans. The
 *   first axis a finger crosses `TAP_SLOP_PX` on decides which, for the rest
 *   of the gesture: horizontal is left to the browser, which pans the
 *   follower's `overflow-x: auto` container natively (the CSS allows exactly
 *   `pan-x` on the terminal), and vertical is turned into scrolling here,
 *   because xterm 6's viewport is a virtual scroller that moves on wheel
 *   events and ignores touch entirely.
 *
 * Only ever enabled in phone mode. On the desk every handler is absent, so a
 * mouse, a trackpad and the desk's focus rules (`useTerminalLifecycle`) are
 * untouched.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Terminal } from "@xterm/xterm";

/**
 * How far a finger may wander and still be holding still, in CSS pixels.
 *
 * Ten is the figure touch toolkits settle on (Android's touch slop is 8dp,
 * iOS's tap tolerance is about the same): comfortably above the jitter of a
 * thumb pressed into glass, well below the smallest deliberate scroll.
 */
export const TAP_SLOP_PX = 10;

/**
 * How long a still finger must stay down to be a long-press rather than a tap.
 *
 * Radix's number, not ours (`ContextMenuTrigger`'s `setTimeout(…, 700)`): a
 * hold at least this long has opened the pane menu, so it must not *also*
 * focus the terminal and throw the keyboard up underneath the menu.
 */
export const LONG_PRESS_MS = 700;

/** Which way a gesture is dragging, once it has decided. */
export type DragAxis = "none" | "x" | "y";

/** What a finished gesture meant. */
export type TouchIntent = "tap" | "long-press" | "drag";

/**
 * The axis a finger `dx`/`dy` from where it went down is dragging along —
 * `"none"` while it is still inside the slop.
 */
export function dragAxis(
  dx: number,
  dy: number,
  slop: number = TAP_SLOP_PX,
): DragAxis {
  if (Math.hypot(dx, dy) <= slop) return "none";
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * What a gesture meant, decided the moment the finger lifts.
 *
 * A finger that ever left the slop dragged, however it ended. One that stayed
 * put is a long-press if the menu opened under it — Android fires a native
 * `contextmenu` before Radix's timer does — or if it was held past Radix's
 * threshold, and a tap otherwise.
 */
export function classifyRelease(gesture: {
  axis: DragAxis;
  heldMs: number;
  menuOpened: boolean;
}): TouchIntent {
  if (gesture.axis !== "none") return "drag";
  if (gesture.menuOpened || gesture.heldMs >= LONG_PRESS_MS) return "long-press";
  return "tap";
}

/**
 * Whole lines to scroll for `pixels` of finger travel, and the pixels left
 * over for the next move.
 *
 * Positive pixels are a finger moving *up*, which — as everywhere on a phone —
 * drags the content up and brings later lines into view: a positive
 * `scrollLines`. The remainder is carried rather than dropped so a slow drag,
 * a pixel or two per move, still scrolls.
 */
export function linesForPixels(
  pixels: number,
  cellHeight: number,
): { lines: number; remainder: number } {
  if (!(cellHeight > 0)) return { lines: 0, remainder: 0 };
  const lines = Math.trunc(pixels / cellHeight);
  return { lines, remainder: pixels - lines * cellHeight };
}

/** One finger's gesture on the terminal, from `touchstart` to lift. */
interface Gesture {
  x: number;
  y: number;
  startedAt: number;
  axis: DragAxis;
  /** Where the last vertical move left the finger. */
  lastY: number;
  /** Scroll pixels not yet worth a whole line. */
  carry: number;
  /** Whether the pane menu opened while this finger was down. */
  menuOpened: boolean;
}

/**
 * Scroll the terminal by `pixels` of vertical finger travel.
 *
 * A normal buffer with nothing listening to the mouse has scrollback, and is
 * scrolled directly. Anything else — a TUI in the alternate screen, or one
 * that asked for mouse reports — is handed a wheel event at the finger, so
 * xterm does with it exactly what it does with a trackpad's: report it to the
 * program, or turn it into arrow keys. (A synthetic wheel cannot scroll the
 * scrollback itself: xterm's scroller reads the legacy `wheelDeltaY`, which a
 * constructed `WheelEvent` always has as 0.)
 */
function scrollTerminal(
  term: Terminal,
  gesture: Gesture,
  pixels: number,
  clientX: number,
  clientY: number,
): void {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const scrollback =
    term.buffer.active.type === "normal" && term.modes.mouseTrackingMode === "none";
  if (scrollback) {
    const cellHeight = screen && term.rows > 0 ? screen.clientHeight / term.rows : 0;
    const { lines, remainder } = linesForPixels(gesture.carry + pixels, cellHeight);
    gesture.carry = remainder;
    if (lines !== 0) term.scrollLines(lines);
    return;
  }
  screen?.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: pixels,
      deltaMode: 0,
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Focus xterm from inside the gesture.
 *
 * The blur first is for iOS. The desk's focus rules put focus in this
 * textarea on mount and whenever the pane becomes the focused one — without a
 * gesture, so with no keyboard — and WebKit raises the keyboard on a *change*
 * of focus: `focus()` on the element that already has it is a no-op, and the
 * keyboard would stay down however often the pane was tapped. Blurring and
 * refocusing in the same task gives it the change it needs.
 */
function focusFromGesture(term: Terminal): void {
  const textarea = term.textarea;
  if (textarea && textarea.ownerDocument.activeElement === textarea) {
    textarea.blur();
  }
  term.focus();
}

/** Whether a gesture started on the terminal itself, not a control over it. */
function onTerminal(term: Terminal | null, target: EventTarget | null): boolean {
  return !!term?.element && target instanceof Node && term.element.contains(target);
}

/** The handlers `TerminalPane` spreads onto its `ContextMenu.Trigger`. */
export interface TerminalTouchTriggerProps {
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerMove?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  onPointerCancel?: (event: React.PointerEvent) => void;
}

export function useTerminalTouch(
  containerRef: React.RefObject<HTMLElement | null>,
  term: Terminal | null,
  enabled: boolean,
): {
  /** Spread onto the `ContextMenu.Trigger` wrapping the terminal. */
  triggerProps: TerminalTouchTriggerProps;
  /** Passed to `ContextMenu.Root`'s `onOpenChange`. */
  onMenuOpenChange: (open: boolean) => void;
} {
  const gestureRef = useRef<Gesture | null>(null);
  /** Where a touch or pen went down, for the Radix long-press timer's sake. */
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const termRef = useRef(term);
  termRef.current = term;

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !term || !container) return;

    const onTouchStart = (event: TouchEvent) => {
      // A second finger is a pinch, not any of the three gestures.
      if (event.touches.length !== 1 || !onTerminal(term, event.target)) {
        gestureRef.current = null;
        return;
      }
      const touch = event.touches[0];
      gestureRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        startedAt: Date.now(),
        axis: "none",
        lastY: touch.clientY,
        carry: 0,
        menuOpened: false,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (event.touches.length !== 1) {
        gestureRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (gesture.axis === "none") {
        gesture.axis = dragAxis(touch.clientX - gesture.x, touch.clientY - gesture.y);
        // Scrolling starts from where the finger left the slop, so the
        // content does not jump by the slop's worth on the first move.
        gesture.lastY = touch.clientY;
        return;
      }
      if (gesture.axis !== "y") return;
      const pixels = gesture.lastY - touch.clientY;
      gesture.lastY = touch.clientY;
      if (pixels !== 0) {
        scrollTerminal(term, gesture, pixels, touch.clientX, touch.clientY);
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      // Another finger still down: this was never a single-finger gesture.
      if (!gesture || event.touches.length > 0) return;
      gestureRef.current = null;
      const intent = classifyRelease({
        axis: gesture.axis,
        heldMs: Date.now() - gesture.startedAt,
        menuOpened: gesture.menuOpened,
      });
      // Synchronously, here, inside the gesture — see the file comment.
      if (intent === "tap") focusFromGesture(term);
    };

    const onTouchCancel = () => {
      gestureRef.current = null;
    };

    // Passive: nothing here cancels a touch. What the browser may do with one
    // is the terminal's `touch-action` (TerminalPane.module.css), decided
    // before any listener runs.
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchCancel);
    return () => {
      gestureRef.current = null;
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [containerRef, term, enabled]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === "mouse" || !onTerminal(termRef.current, event.target)) {
      pointerStartRef.current = null;
      return;
    }
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const start = pointerStartRef.current;
    if (event.pointerType === "mouse" || !start) return;
    if (dragAxis(event.clientX - start.x, event.clientY - start.y) === "none") {
      // A wobble, not a drag: keep Radix's long-press timer running.
      event.preventDefault();
      return;
    }
    // A drag. Let Radix cancel its timer, and do not revive it if the finger
    // wanders back.
    pointerStartRef.current = null;
  }, []);

  const clearPointer = useCallback(() => {
    pointerStartRef.current = null;
  }, []);

  const onMenuOpenChange = useCallback((open: boolean) => {
    if (open && gestureRef.current) gestureRef.current.menuOpened = true;
  }, []);

  const triggerProps = useMemo<TerminalTouchTriggerProps>(
    () =>
      enabled
        ? {
            onPointerDown,
            onPointerMove,
            onPointerUp: clearPointer,
            onPointerCancel: clearPointer,
          }
        : {},
    [enabled, onPointerDown, onPointerMove, clearPointer],
  );

  return { triggerProps, onMenuOpenChange };
}
