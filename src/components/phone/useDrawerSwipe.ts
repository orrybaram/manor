import { useRef, type TouchEvent } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";

/** A finger has to travel this far before the swipe picks an axis. */
const AXIS_SLOP_PX = 8;
/** Dragged further left than this, the drawer closes; short of it, it
 *  springs back. */
const CLOSE_DISTANCE_PX = 60;
/** A swipe that opens the drawer has to start in this left fraction of the
 *  screen. Not a thin edge strip: on Android with gesture navigation the
 *  system back gesture owns the outermost ~20–30px, and a swipe that starts
 *  there is the OS's, never the page's. */
const OPEN_ZONE_FRACTION = 0.5;
/** Dragged further right than this from the edge, the drawer opens. */
const OPEN_DISTANCE_PX = 40;

type Axis = "x" | "y";

/**
 * The one direction-lock both gestures share: no axis until the finger has
 * travelled `AXIS_SLOP_PX`, then whichever way it has gone further.
 */
function lockAxis(dx: number, dy: number): Axis | null {
  if (Math.abs(dx) < AXIS_SLOP_PX && Math.abs(dy) < AXIS_SLOP_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/**
 * Whether something under the finger would scroll if dragged rightward —
 * a wide terminal follower or a code block panned away from its start. That
 * drag is the scroller's; one already at its left edge has nothing to give.
 */
function canScrollLeftUnder(target: EventTarget | null): boolean {
  for (
    let el = target instanceof Element ? target : null;
    el;
    el = el.parentElement
  ) {
    if (el.scrollLeft > 0) {
      const { overflowX } = getComputedStyle(el);
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
  }
  return false;
}

/**
 * Any dialog, sheet or menu on screen: the drawer (open already), a sheet,
 * the palette, a rename prompt, a long-press or overflow menu. Radix gives
 * each of them one of these roles, and one leaving keeps it with
 * `data-state="closed"` until its exit animation ends.
 */
const OVERLAY_SELECTOR = [
  '[role="dialog"]:not([data-state="closed"])',
  '[role="alertdialog"]:not([data-state="closed"])',
  '[role="menu"]:not([data-state="closed"])',
].join(", ");

function overlayOpen(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/**
 * Swipe right from the left half of the screen to open the drawer. Listens on
 * the document in the capture phase, so a terminal or the chat transcript
 * under the finger can't swallow the gesture first; a gesture that starts out
 * vertical is that view's scroll and is left alone, and so is one that starts
 * on something that can still scroll left (`canScrollLeftUnder`). While any
 * overlay is open (`overlayOpen`) the gesture is that overlay's, and does
 * nothing.
 */
export function useSwipeToOpenDrawer(onOpen: () => void) {
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useMountEffect(() => {
    let gesture: { x: number; y: number; axis: Axis | null } | null = null;

    const onStart = (e: globalThis.TouchEvent) => {
      const t = e.touches[0];
      gesture =
        e.touches.length === 1 &&
        t.clientX <= window.innerWidth * OPEN_ZONE_FRACTION &&
        !canScrollLeftUnder(e.target) &&
        !overlayOpen()
          ? { x: t.clientX, y: t.clientY, axis: null }
          : null;
    };
    const onMove = (e: globalThis.TouchEvent) => {
      const g = gesture;
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      g.axis ??= lockAxis(dx, dy);
      if (g.axis === "y") {
        gesture = null;
        return;
      }
      if (g.axis === "x" && dx > OPEN_DISTANCE_PX) {
        gesture = null;
        if (!overlayOpen()) openRef.current();
      }
    };
    const onEnd = () => {
      gesture = null;
    };

    const opts = { capture: true, passive: true };
    document.addEventListener("touchstart", onStart, opts);
    document.addEventListener("touchmove", onMove, opts);
    document.addEventListener("touchend", onEnd, opts);
    document.addEventListener("touchcancel", onEnd, opts);
    return () => {
      document.removeEventListener("touchstart", onStart, opts);
      document.removeEventListener("touchmove", onMove, opts);
      document.removeEventListener("touchend", onEnd, opts);
      document.removeEventListener("touchcancel", onEnd, opts);
    };
  });
}

/**
 * Swipe the drawer away: it follows a leftward drag and closes past
 * `CLOSE_DISTANCE_PX`. A gesture that starts out vertical is the drawer's
 * own scroll and is left alone. Touch events rather than pointer events:
 * the browser cancels a pointer the moment it starts scrolling.
 *
 * The offset is `--swipe-x` on the sheet, set straight on the element so a
 * drag re-renders nothing; the close animation starts from it
 * (`SidebarDrawer.module.css`), so the sheet leaves from where the finger
 * let go instead of jumping back first.
 */
export function useSwipeToClose(onClose: () => void) {
  const gesture = useRef<{ x: number; y: number; axis: Axis | null } | null>(
    null,
  );

  const reset = (el: HTMLElement) => {
    el.removeAttribute("data-swiping");
    el.style.removeProperty("--swipe-x");
  };

  return {
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      const t = e.touches[0];
      gesture.current =
        e.touches.length === 1 ? { x: t.clientX, y: t.clientY, axis: null } : null;
    },
    onTouchMove: (e: TouchEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      g.axis ??= lockAxis(dx, t.clientY - g.y);
      if (g.axis !== "x") return;
      e.currentTarget.setAttribute("data-swiping", "");
      e.currentTarget.style.setProperty("--swipe-x", `${Math.min(0, dx)}px`);
    },
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || g.axis !== "x") return;
      const el = e.currentTarget;
      const dx = e.changedTouches[0].clientX - g.x;
      if (dx < -CLOSE_DISTANCE_PX) {
        // `--swipe-x` stays: the close animation starts from it.
        el.removeAttribute("data-swiping");
        onClose();
      } else {
        reset(el);
      }
    },
    onTouchCancel: (e: TouchEvent<HTMLElement>) => {
      gesture.current = null;
      reset(e.currentTarget);
    },
  };
}
