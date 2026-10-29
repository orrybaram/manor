import { create } from "zustand";

const WIDTH_KEY = "manor:fileDrawerWidth";
const DEFAULT_WIDTH = 240;
export const MIN_WIDTH = 140;
export const MAX_WIDTH = 600;
/** Dragged narrower than this, the drawer collapses into the strip. */
export const COLLAPSE_SNAP = 80;

function loadWidth(): number {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) return width;
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

/**
 * The drawer's width, one for every file pane, kept across relaunches; and
 * whether an edge drag is under way, so the handle stays lit while the drag
 * collapses the drawer and opens it again under it.
 */
export const useFileDrawerLayout = create<{ width: number; dragging: boolean }>(() => ({
  width: loadWidth(),
  dragging: false,
}));

export function saveWidth(): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(useFileDrawerLayout.getState().width));
  } catch {
    /* ignore */
  }
}
