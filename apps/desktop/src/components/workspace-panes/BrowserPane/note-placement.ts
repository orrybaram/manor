/**
 * Where a pin's note popover goes over the page. The page reports its pins in
 * its own CSS pixels; the pane draws in its own, which differ by the page's
 * zoom — so rects are scaled by the ratio of the two viewport widths. And
 * whether it may take the keyboard when it opens.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/** Space kept clear of the pane's edges, and of the notes pill along the bottom. */
const EDGE = 8;
const GAP = 8;
export const PILL_CLEARANCE = 52;

/** `rect`, from the page's CSS pixels into the pane's. */
export function toPaneRect(rect: Rect, pageWidth: number, paneWidth: number): Rect {
  const scale = pageWidth > 0 ? paneWidth / pageWidth : 1;
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * The popover's top-left in the pane: under the element, lined up with its
 * pin; above it when there is no room below; failing both, just inside the
 * element beside its pin. Always kept inside the pane and above the pill.
 */
export function placeNotePopover(element: Rect, pane: Size, popover: Size): { left: number; top: number } {
  const maxLeft = Math.max(EDGE, pane.width - popover.width - EDGE);
  const left = Math.min(Math.max(element.x, EDGE), maxLeft);
  const floor = pane.height - PILL_CLEARANCE;

  const below = element.y + element.height + GAP;
  const above = element.y - GAP - popover.height;
  let top: number;
  if (below + popover.height <= floor) top = below;
  else if (above >= EDGE) top = above;
  else top = element.y + 14;

  const maxTop = Math.max(EDGE, floor - popover.height);
  return { left, top: Math.min(Math.max(top, EDGE), maxTop) };
}

/** Whether `active` is a field outside `popover`'s pane that the user may be typing in. */
export function typingElsewhere(active: Element | null, popover: Element | null): boolean {
  if (!active || active === document.body) return false;
  const pane = popover?.closest("[data-pane-id]") ?? popover?.parentElement ?? null;
  if (pane?.contains(active)) return false;
  return active.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}
