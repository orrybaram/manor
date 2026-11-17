/**
 * Drag regions stand down while a popover or menu is open.
 *
 * A drag region swallows mouse-downs before the DOM sees them, so clicking
 * the title bar could never dismiss an open popover or menu. While one is
 * open, `<html>` carries {@link POPOVER_OPEN_CLASS} and every drag region
 * stands down (App.css). Tooltips are poppers too but carry neither role, so
 * hovering one leaves the window draggable.
 *
 * This used to be `html:has(...) *` in CSS. A `:has()` on the root, with a
 * descendant argument, makes Chromium re-check the root on DOM changes
 * anywhere, and a match there restyles every element in the window. xterm's
 * DOM renderer measures glyph widths by setting a span's text and reading its
 * width, so each measure paid for a whole-window restyle: about 4 ms each,
 * and a second and more of them on every workspace switch with many
 * terminals open.
 */

export const POPOVER_OPEN_CLASS = "popover-open";

/**
 * An open Radix popover (role="dialog") or menu, inside a popper. `data-state`
 * flips to "closed" as soon as one starts closing, so the class goes then
 * rather than after its exit animation.
 */
const OPEN_POPPER =
  '[data-radix-popper-content-wrapper] :is([role="dialog"], [role="menu"], [role="listbox"])[data-state="open"]';

/**
 * Keep {@link POPOVER_OPEN_CLASS} on `<html>` in step with open poppers.
 * Returns a function that stops watching.
 *
 * Two cheap signals cover every popper:
 * - a portal mounting or unmounting is a child of `<body>` coming or going;
 * - one rendered in place (`SearchableSelect`) has a Radix trigger, whose
 *   `data-state` flips when it opens, and its content's flips when it closes.
 * Neither watches the text and rows a terminal rewrites all the time.
 */
export function watchPopoversForDragRegions(doc: Document = document): () => void {
  const update = () => {
    doc.documentElement.classList.toggle(
      POPOVER_OPEN_CLASS,
      doc.querySelector(OPEN_POPPER) !== null,
    );
  };
  const portals = new MutationObserver(update);
  portals.observe(doc.body, { childList: true });
  const states = new MutationObserver(update);
  states.observe(doc.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
  update();
  return () => {
    portals.disconnect();
    states.disconnect();
    doc.documentElement.classList.remove(POPOVER_OPEN_CLASS);
  };
}
