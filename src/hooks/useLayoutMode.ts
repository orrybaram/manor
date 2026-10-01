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

/**
 * Put the layout mode on `<html data-layout>` as well as on `.app`.
 *
 * `App` sets `data-layout` on its `.app` root, which every in-tree phone rule
 * keys off. A Radix portal is not in that tree — it mounts under `<body>` — so
 * phone CSS for portaled UI (the command palette) could never match
 * `.app[data-layout="phone"]`, and the palette opened on a phone as the desk's
 * centered card. Portaled rules key off `:root[data-layout="phone"]` instead,
 * and this keeps that attribute true. It is done here, in the one listener
 * that already decides the mode, rather than in a second effect that could
 * disagree with it.
 */
function mirrorOntoDocument(): void {
  document.documentElement.dataset.layout = getSnapshot();
}

/** Subscribes `onChange` to the media query the layout mode reads. */
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(PHONE_QUERY);
  const handle = () => {
    mirrorOntoDocument();
    onChange();
  };
  mirrorOntoDocument();
  mql.addEventListener("change", handle);
  return () => mql.removeEventListener("change", handle);
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
