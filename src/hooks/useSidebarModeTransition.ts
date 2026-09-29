import { useEffect, useState } from "react";
import type { SidebarMode } from "../store/project-store";

/** How long a sidebar mode change animates; App.tsx hands it to CSS. */
export const SIDEBAR_MODE_TRANSITION_MS = 200;

/**
 * True for `SIDEBAR_MODE_TRANSITION_MS` after the sidebar mode changes —
 * from the toggle, the menu, or a resize drag crossing the rail snap point.
 *
 * Widths only transition while this is set, so resizing the full sidebar
 * still tracks the pointer 1:1. It flips on in the same render as the mode,
 * so the first frame of the new width already has the transition.
 */
export function useSidebarModeTransition(mode: SidebarMode): boolean {
  const [prevMode, setPrevMode] = useState(mode);
  const [animating, setAnimating] = useState(false);
  if (mode !== prevMode) {
    setPrevMode(mode);
    setAnimating(true);
  }

  // Keyed on `mode` too, so flipping back mid-animation restarts the clock.
  useEffect(() => {
    if (!animating) return;
    const timer = setTimeout(() => setAnimating(false), SIDEBAR_MODE_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [animating, mode]);

  return animating;
}
