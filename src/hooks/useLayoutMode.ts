import { useSyncExternalStore } from "react";

/**
 * ADR-181 D2: one hook decides "is this renderer in phone mode?" so CSS and
 * components read the same answer. Everything else in ADR-181 builds on top
 * of `useLayoutMode()` — it introduces no new state, only a read of the
 * viewport the renderer already has.
 */
export type LayoutMode = "phone" | "desk";

/**
 * ADR-178 D9 set the phone breakpoint at "~768 px" — below it a renderer's
 * width alone reads as a phone. `.app[data-layout="phone"]` CSS keys off the
 * same number.
 */
export const PHONE_MAX_WIDTH = 767;

const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/** Subscribes `onChange` to the media query the layout mode reads. */
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * `"phone"` below the breakpoint, with one exception: a detached window
 * (ADR-179 D4) is always `"desk"`. It is often narrow on purpose — a single
 * claimed tab with no chrome — and ADR-181 D2 excludes it regardless of
 * width, so tearing a pane out into a small window never flips it into phone
 * mode.
 */
function getSnapshot(): LayoutMode {
  if (window.electronAPI.isDetached) return "desk";
  return window.matchMedia(PHONE_QUERY).matches ? "phone" : "desk";
}

/** No window to measure on the server: default to the desk layout. */
function getServerSnapshot(): LayoutMode {
  return "desk";
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
