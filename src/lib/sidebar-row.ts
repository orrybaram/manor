/**
 * The sidebar's focusable rows — workspace rows and folder headers (ADR-172).
 *
 * `data-sidebar-row` marks whatever element takes focus for a row. Keyboard
 * navigation walks these, and `focus-regions` picks one when focus jumps into
 * the sidebar. The terminal's "don't steal focus" guard now keys off the whole
 * sidebar region (`isNavRegionFocused`, ADR-175) rather than rows alone.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useAppStore } from "../store/app-store";

export const SIDEBAR_ROW_SELECTOR = "[data-sidebar-row]";

/**
 * Move focus one row along in document order. Rows are collected from the
 * whole document rather than the project they belong to, so ↑/↓ walks out of
 * a folder and on into the next project the way the eye does.
 */
function focusAdjacentRow(from: HTMLElement, delta: 1 | -1): void {
  const rows = Array.from(
    from.ownerDocument.querySelectorAll<HTMLElement>(SIDEBAR_ROW_SELECTOR),
  );
  const index = rows.indexOf(from);
  if (index < 0) return;
  rows[index + delta]?.focus();
}

type SidebarRowKeyActions = {
  /** Enter — open the row's inline rename. */
  startRename: () => void;
  /**
   * ← / → — collapse / expand. Only folder headers pass this; a workspace row
   * has nothing to open.
   */
  setExpanded?: (expanded: boolean) => void;
};

/**
 * Keyboard handling shared by workspace rows and folder headers. Callers wire
 * it to the row's `onKeyDown` and skip it while the row's inline rename input
 * is open — that input stops propagation, so these keys stay out of a rename.
 */
export function handleSidebarRowKeyDown(
  e: ReactKeyboardEvent<HTMLElement>,
  actions: SidebarRowKeyActions,
): void {
  // A row wraps other focusable things (the PR popover's trigger, for one).
  // Their keys are their own business.
  if (e.target !== e.currentTarget) return;

  switch (e.key) {
    case "Enter":
      e.preventDefault();
      actions.startRename();
      break;
    case "ArrowDown":
      // Without this the row scrolls the sidebar as well as moving focus,
      // and the list jumps two rows for one press.
      e.preventDefault();
      focusAdjacentRow(e.currentTarget, 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      focusAdjacentRow(e.currentTarget, -1);
      break;
    case "ArrowLeft":
      if (!actions.setExpanded) return;
      e.preventDefault();
      actions.setExpanded(false);
      break;
    case "ArrowRight":
      if (!actions.setExpanded) return;
      e.preventDefault();
      actions.setExpanded(true);
      break;
    case "Escape":
      // Hand the keyboard back to the pane: dropping DOM focus alone would
      // leave it on <body>, so ask the active terminal to take it explicitly.
      e.preventDefault();
      e.currentTarget.blur();
      useAppStore.getState().refocusActivePane();
      break;
  }
}
