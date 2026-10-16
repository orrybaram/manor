// Pure helpers for the window's top-left controls (ADR-196).

import type { SidebarMode } from "../store/project-store";
import { hasTrafficLights } from "./platform";

/**
 * The lead's width over a hidden sidebar: lights, back/forward and the bell.
 * Measured with the macOS lights; `windowLeadWidth` swaps in the platform's.
 */
export const LEAD_COMPACT_WIDTH = 166;

/** Room for the macOS traffic lights; all the lead holds over the rail. */
export const LIGHTS_WIDTH = 78;

/**
 * The lead's left gutter where there are no traffic lights: puts the back
 * arrow's icon in line with the sidebar's nav icons below it.
 */
export const NO_LIGHTS_WIDTH = 15;

/** The lead's left gutter on this platform. */
export function lightsWidth(): number {
  return hasTrafficLights() ? LIGHTS_WIDTH : NO_LIGHTS_WIDTH;
}

/** Width of the collapsed sidebar rail (ADR-195). */
export const RAIL_WIDTH = 72;

/** Gutter between panels and window edges; mirrors `--frame-gap` in App.css. */
export const FRAME_GAP = 6;

/**
 * How wide the top-left lead (traffic-light space, back/forward, bell) is:
 * as wide as the sidebar panel under it, else compact. Never narrower than
 * compact, so a narrow sidebar's lead overhangs into the top-left tab bar
 * rather than clipping its controls. Over the rail it holds only the lights
 * (the bell moves into the rail), so it fits within the rail's column.
 */
export function windowLeadWidth(
  mode: SidebarMode,
  sidebarWidth: number,
  lights = LIGHTS_WIDTH,
): number {
  if (mode === "rail") return lights;
  const compact = LEAD_COMPACT_WIDTH - LIGHTS_WIDTH + lights;
  return mode === "full" ? Math.max(sidebarWidth, compact) : compact;
}

/** Width of the column left of the workspace: rail, sidebar panel, or none. */
function leftColumnWidth(mode: SidebarMode, sidebarWidth: number): number {
  if (mode === "full") return sidebarWidth + 2 * FRAME_GAP;
  if (mode === "rail") return RAIL_WIDTH + FRAME_GAP;
  return 0;
}

/**
 * Width of the column App.tsx holds the rail or sidebar panel in. Hidden
 * keeps a gutter so the workspace's left edge doesn't jump when the column
 * animates to or from it.
 */
export function sidebarColumnWidth(mode: SidebarMode, sidebarWidth: number): number {
  return mode === "hidden" ? FRAME_GAP : leftColumnWidth(mode, sidebarWidth);
}

/**
 * How far the top-left panel's tab bar must start in so its tabs clear the
 * lead: the part of the lead that overhangs the workspace.
 */
export function windowLeadInset(
  mode: SidebarMode,
  sidebarWidth: number,
  lights = LIGHTS_WIDTH,
): number {
  return Math.max(
    0,
    windowLeadWidth(mode, sidebarWidth, lights) -
      leftColumnWidth(mode, sidebarWidth),
  );
}
