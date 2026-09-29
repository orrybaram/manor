// Pure helpers for the window's top-left controls (ADR-196).

import type { SidebarMode } from "../store/project-store";

/** The lead's width when there is no full sidebar under it. */
export const LEAD_COMPACT_WIDTH = 166;

/** Width of the collapsed sidebar rail (ADR-195). */
export const RAIL_WIDTH = 52;

/** Gutter between panels and window edges; mirrors `--frame-gap` in App.css. */
export const FRAME_GAP = 6;

/**
 * How wide the top-left lead (traffic-light space, sidebar toggle,
 * back/forward) is: as wide as the sidebar panel under it, else compact.
 */
export function windowLeadWidth(mode: SidebarMode, sidebarWidth: number): number {
  return mode === "full" ? sidebarWidth : LEAD_COMPACT_WIDTH;
}

/** Width of the column left of the workspace: rail, sidebar panel, or none. */
function leftColumnWidth(mode: SidebarMode, sidebarWidth: number): number {
  if (mode === "full") return sidebarWidth + 2 * FRAME_GAP;
  if (mode === "rail") return RAIL_WIDTH + FRAME_GAP;
  return 0;
}

/**
 * How far the top-left panel's tab bar must start in so its tabs clear the
 * lead: the part of the lead that overhangs the workspace.
 */
export function windowLeadInset(mode: SidebarMode, sidebarWidth: number): number {
  return Math.max(
    0,
    windowLeadWidth(mode, sidebarWidth) - leftColumnWidth(mode, sidebarWidth),
  );
}
