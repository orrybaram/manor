/**
 * The pure half of a browser pane's docked DevTools, shared by the renderer
 * (which lays out the slot and decides when the view may show) and Electron
 * main (which places the native view). No DOM and no Electron here, so both
 * sides and the unit tests can import it.
 *
 * Docked DevTools are a native `WebContentsView` laid over an empty slot in
 * the pane. A native view paints above every DOM element, so it shows only
 * while nothing of Manor's is drawn over that slot.
 */

/** Which edge of the pane DevTools sit on. */
export type DevToolsDockSide = "bottom" | "right";

/** A rectangle in window coordinates: CSS pixels in the renderer, DIPs in main. */
export interface DockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Share of the pane DevTools take when first opened, on either side. */
export const DEFAULT_DOCK_FRACTION = 0.4;

/** The drag handle between the page and DevTools, in CSS pixels. */
export const DOCK_HANDLE_PX = 5;

/** Neither the page nor DevTools may be dragged smaller than this. */
export const MIN_DOCK_PANE_PX = 120;

/**
 * Keep DevTools' share of a `paneSize`-pixel pane within limits: at least
 * {@link MIN_DOCK_PANE_PX} each for DevTools and the page. A pane too small
 * for both splits evenly. A non-finite share falls back to the default.
 */
export function clampDockFraction(fraction: number, paneSize: number): number {
  const value = Number.isFinite(fraction) ? fraction : DEFAULT_DOCK_FRACTION;
  if (!(paneSize > 0)) return Math.min(1, Math.max(0, value));
  const usable = paneSize - DOCK_HANDLE_PX;
  const min = MIN_DOCK_PANE_PX / usable;
  const max = 1 - MIN_DOCK_PANE_PX / usable;
  if (min > max) return 0.5;
  return Math.min(max, Math.max(min, value));
}

/**
 * DevTools' share of the pane with the drag handle at `pointer` (window
 * coordinates), clamped: the part of the pane past the pointer, toward the
 * docked edge.
 */
export function dockFractionAt(
  side: DevToolsDockSide,
  pointer: { x: number; y: number },
  pane: DockRect,
): number {
  const size = side === "bottom" ? pane.height : pane.width;
  const end = side === "bottom" ? pane.y + pane.height : pane.x + pane.width;
  const at = side === "bottom" ? pointer.y : pointer.x;
  if (!(size > 0)) return DEFAULT_DOCK_FRACTION;
  return clampDockFraction((end - at - DOCK_HANDLE_PX / 2) / (size - DOCK_HANDLE_PX), size);
}

/**
 * Where the native view goes for a slot measured at `slot` (CSS pixels) in a
 * renderer zoomed by `zoomFactor`, inside a window content area of
 * `content`. Edges, not sizes, are rounded, so the view meets the handle
 * without a hairline gap at fractional zoom; then it is clipped to the
 * content area. Null when nothing of it is left to show.
 */
export function toViewBounds(
  slot: DockRect,
  zoomFactor: number,
  content: { width: number; height: number },
): DockRect | null {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const left = Math.max(0, Math.round(slot.x * zoom));
  const top = Math.max(0, Math.round(slot.y * zoom));
  const right = Math.min(content.width, Math.round((slot.x + slot.width) * zoom));
  const bottom = Math.min(content.height, Math.round((slot.y + slot.height) * zoom));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Whether `value` is a finite rect a renderer may report (validated in main). */
export function isDockRect(value: unknown): value is DockRect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every(
    (key) => typeof rect[key] === "number" && Number.isFinite(rect[key]),
  );
}

/** Whether two rects share any area. */
export function rectsOverlap(a: DockRect, b: DockRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * One piece of Manor UI drawn above panes. A `modal` one (a dialog, the
 * command palette) dims the whole window, so it covers the slot wherever it
 * sits; any other (a menu, popover, toast) only where its box overlaps.
 */
export interface DockOverlay {
  rect: DockRect;
  modal: boolean;
}

/** Whether any of `overlays` is drawn over the slot at `slot`. */
export function overlaysCover(slot: DockRect, overlays: readonly DockOverlay[]): boolean {
  return overlays.some((overlay) => overlay.modal || rectsOverlap(slot, overlay.rect));
}

/** What the view should do: sit over the slot, hide, or hide behind its snapshot. */
export type DockViewState =
  | { kind: "shown"; rect: DockRect }
  | { kind: "hidden" }
  | { kind: "covered" };

export interface DockViewInputs {
  /** The slot's client rect. */
  slot: DockRect;
  /** The slot is rendered: not `display: none`, `visibility: hidden` or in a hidden layer. */
  rendered: boolean;
  /** The window's viewport, to tell a slot scrolled or moved off screen. */
  viewport: { width: number; height: number };
  /** A pane or tab drag is under way: drop targets must get the pointer. */
  dragging: boolean;
  /** The DevTools split is being resized: the handle must keep the pointer. */
  resizing: boolean;
  /** Manor UI is drawn over the slot. */
  covered: boolean;
}

/**
 * Decide the view's state. Off screen (an inactive tab or workspace, a zero
 * size slot) it simply hides; on screen but under Manor UI or a drag it hides
 * behind a snapshot of itself, so the area does not flash blank.
 */
export function dockViewState(inputs: DockViewInputs): DockViewState {
  const { slot, viewport } = inputs;
  const onScreen =
    inputs.rendered &&
    rectsOverlap(slot, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  if (!onScreen) return { kind: "hidden" };
  if (inputs.dragging || inputs.resizing || inputs.covered) return { kind: "covered" };
  return { kind: "shown", rect: roundRect(slot) };
}

/** A rect with whole-pixel edges. */
export function roundRect(rect: DockRect): DockRect {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x,
    y,
    width: Math.round(rect.x + rect.width) - x,
    height: Math.round(rect.y + rect.height) - y,
  };
}

/**
 * A key for a view state, so the renderer reports only changes. The device
 * pixel ratio is part of it: a zoom change moves the view in DIPs without
 * changing any CSS pixel.
 */
export function dockViewStateKey(state: DockViewState, devicePixelRatio: number): string {
  if (state.kind !== "shown") return state.kind;
  const { x, y, width, height } = state.rect;
  return `${x},${y},${width},${height}@${devicePixelRatio}`;
}
