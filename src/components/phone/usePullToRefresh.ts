import { useCallback, useState } from "react";

/** A finger travels this far for each `1 / PULL_DAMPING` px the indicator moves. */
const PULL_DAMPING = 0.5;
/** The indicator never travels further than this. */
export const MAX_PULL_PX = 96;
/** Released past this, the pull refreshes. */
export const TRIGGER_PULL_PX = 64;
/** Where the indicator rests while refreshing; fully opaque from here. */
export const HOLD_PX = 48;
/** The spinner shows at least this long, so a fast refresh still reads. */
const MIN_REFRESH_MS = 400;

/** The indicator's travel for a finger that has moved `dy` px down. */
export function dampPull(dy: number): number {
  return Math.min(Math.max(dy, 0) * PULL_DAMPING, MAX_PULL_PX);
}

/** Whether a pull of `pull` px (already damped) refreshes on release. */
export function pullTriggers(pull: number): boolean {
  return pull >= TRIGGER_PULL_PX;
}

type PullState = { pull: number; refreshing: boolean };

/**
 * Pull-to-refresh for a scroller. A downward drag that starts
 * with the element scrolled to the top travels an indicator; released far
 * enough, it runs `onRefresh` and holds the indicator until it settles.
 *
 * Never scrolls the element itself, so a chat's bottom-follow logic is not
 * disturbed. `ref` is a callback ref: the touch listeners attach when the
 * element mounts, however late, and detach when it goes. It is stable for as
 * long as `onRefresh` is, so pass a stable function — a new one re-attaches.
 */
export function usePullToRefresh(onRefresh: () => Promise<void>): PullState & {
  ref: (el: HTMLElement | null) => (() => void) | undefined;
} {
  const [state, setState] = useState<PullState>({ pull: 0, refreshing: false });

  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;

      let startY = 0;
      let tracking = false;
      let pulling = false;
      let pull = 0;
      let refreshing = false;

      const onStart = (e: TouchEvent) => {
        tracking = false;
        pulling = false;
        if (refreshing || e.touches.length !== 1 || el.scrollTop > 0) return;
        startY = e.touches[0].clientY;
        tracking = true;
      };

      const onMove = (e: TouchEvent) => {
        if (!tracking) return;
        const dy = e.touches[0].clientY - startY;
        if (!pulling) {
          // An upward drag is a scroll; leave it to the browser.
          if (dy <= 0) {
            if (dy < -4) tracking = false;
            return;
          }
          pulling = true;
        }
        // The browser would otherwise scroll or rubber-band under the pull.
        if (e.cancelable) e.preventDefault();
        pull = dampPull(dy);
        setState({ pull, refreshing: false });
      };

      const onEnd = () => {
        if (!tracking) return;
        tracking = false;
        if (!pulling) return;
        pulling = false;
        if (!pullTriggers(pull)) {
          pull = 0;
          setState({ pull: 0, refreshing: false });
          return;
        }
        refreshing = true;
        setState({ pull: HOLD_PX, refreshing: true });
        const minimum = new Promise<void>((resolve) => setTimeout(resolve, MIN_REFRESH_MS));
        const run = onRefresh().catch(() => {});
        void Promise.all([run, minimum]).then(() => {
          refreshing = false;
          pull = 0;
          setState({ pull: 0, refreshing: false });
        });
      };

      el.addEventListener("touchstart", onStart, { passive: true });
      // Not passive: a pull in progress has to cancel the browser's scroll.
      el.addEventListener("touchmove", onMove, { passive: false });
      el.addEventListener("touchend", onEnd, { passive: true });
      el.addEventListener("touchcancel", onEnd, { passive: true });
      return () => {
        el.removeEventListener("touchstart", onStart);
        el.removeEventListener("touchmove", onMove);
        el.removeEventListener("touchend", onEnd);
        el.removeEventListener("touchcancel", onEnd);
      };
    },
    [onRefresh],
  );

  return { ref, ...state };
}
