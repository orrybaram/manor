import type { DockOverlay } from "../../../lib/devtools-dock";

/**
 * An open dialog: the command palette, Settings, every confirm. These dim
 * the whole window, so they cover docked DevTools wherever they sit. The same
 * selector `keybinding-commands.ts` uses for the modal scope.
 */
const MODAL_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * Layers that cover DevTools only where they overlap them:
 *
 * - every Radix popper (menus, context menus, popovers, selects, tooltips),
 *   which portal into `[data-radix-popper-content-wrapper]`;
 * - hand-rolled menus and listboxes;
 * - the toast deck;
 * - anything else of Manor's drawn over panes, which marks itself
 *   `data-floats-over-panes` (the URL autocomplete, achievement toasts).
 */
const LAYER_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  '[role="menu"]',
  '[role="listbox"]',
  '[data-testid="toast-deck"]',
  "[data-floats-over-panes]",
].join(", ");

const ALL_SELECTOR = `${MODAL_SELECTOR}, ${LAYER_SELECTOR}`;

/**
 * Every piece of Manor UI now painted above panes, for `overlaysCover`. A
 * layer holding `slot` is under DevTools, not over them; one not painted (a
 * closed popover still animating out, a hidden layer) is skipped.
 */
export function overlaysAbove(slot: Element): DockOverlay[] {
  const overlays: DockOverlay[] = [];
  for (const element of document.querySelectorAll(ALL_SELECTOR)) {
    if (element.contains(slot)) continue;
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const modal =
      element.matches(MODAL_SELECTOR) &&
      element.closest("[data-radix-popper-content-wrapper]") === null;
    const box = element.getBoundingClientRect();
    overlays.push({
      modal,
      rect: { x: box.left, y: box.top, width: box.width, height: box.height },
    });
  }
  return overlays;
}
