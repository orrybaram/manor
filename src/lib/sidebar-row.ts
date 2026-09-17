/**
 * The sidebar's focusable rows (ADR-172, ADR-175): the Home row, project
 * headers, workspace rows and folder headers.
 *
 * `data-sidebar-row` marks whatever element takes focus for a row. Keyboard
 * navigation walks these, and `focus-regions` picks one when focus jumps into
 * the sidebar. The terminal's "don't steal focus" guard keys off the whole
 * sidebar region (`isNavRegionFocused`), not rows alone.
 *
 * The rows share one Tab stop (a roving tabindex): exactly one row carries
 * `tabindex="0"` and the rest `-1`. See `installRovingRows`.
 */

import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useAppStore } from "../store/app-store";

export const SIDEBAR_ROW_SELECTOR = "[data-sidebar-row]";

function allRows(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(SIDEBAR_ROW_SELECTOR));
}

/**
 * Move focus one row along in document order. Rows are collected from the
 * whole document rather than the project they belong to, so ↑/↓ walks out of
 * a folder and on into the next project the way the eye does.
 */
function focusAdjacentRow(from: HTMLElement, delta: 1 | -1): void {
  const rows = allRows(from.ownerDocument);
  const index = rows.indexOf(from);
  if (index < 0) return;
  rows[index + delta]?.focus();
}

function focusEdgeRow(from: HTMLElement, edge: "first" | "last"): void {
  const rows = allRows(from.ownerDocument);
  (edge === "first" ? rows[0] : rows[rows.length - 1])?.focus();
}

export type SidebarRowKeyActions = {
  /**
   * Enter / Space — the row's primary action: open the workspace (or Home),
   * or toggle a project / folder header.
   */
  activate: () => void;
  /** F2 — open the row's inline rename. Rows that can't be renamed omit it. */
  startRename?: () => void;
  /**
   * ← / → — collapse / expand. Only project and folder headers pass this; a
   * workspace row has nothing to open.
   */
  setExpanded?: (expanded: boolean) => void;
  /**
   * Shift+F10, the ContextMenu key or ⌘. — open the row's context menu.
   * Without it those keys do nothing here.
   */
  openMenu?: (row: HTMLElement) => void;
};

function isMenuKey(e: ReactKeyboardEvent<HTMLElement>): boolean {
  if (e.key === "ContextMenu") return true;
  if (e.key === "F10" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return true;
  }
  return e.key === "." && e.metaKey && !e.ctrlKey && !e.altKey;
}

/**
 * Keyboard handling shared by every sidebar row. Callers wire it to the row's
 * `onKeyDown` and skip it while the row's inline rename input is open — that
 * input stops propagation of its plain keys, so these stay out of a rename.
 */
export function handleSidebarRowKeyDown(
  e: ReactKeyboardEvent<HTMLElement>,
  actions: SidebarRowKeyActions,
): void {
  // A row wraps other focusable things (the PR popover's trigger, for one).
  // Their keys are their own business.
  if (e.target !== e.currentTarget) return;

  if (isMenuKey(e)) {
    if (!actions.openMenu) return;
    e.preventDefault();
    actions.openMenu(e.currentTarget);
    return;
  }

  // Anything held with ⌘ / Ctrl / ⌥ is an app shortcut, not row navigation.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case "Enter":
    case " ":
      // Space would otherwise scroll the sidebar.
      e.preventDefault();
      actions.activate();
      break;
    case "F2":
      if (!actions.startRename) return;
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
    case "Home":
      e.preventDefault();
      focusEdgeRow(e.currentTarget, "first");
      break;
    case "End":
      e.preventDefault();
      focusEdgeRow(e.currentTarget, "last");
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

// ── Roving tabindex ──────────────────────────────────────────────────────

/** The row the user last focused, per sidebar root. */
const lastFocusedRow = new WeakMap<ParentNode, HTMLElement>();

/**
 * Give exactly one row under `root` `tabindex="0"` and the rest `-1`. The Tab
 * stop is the row the user last focused while it is still rendered, else the
 * current row (`aria-current="true"` — the active workspace, or Home), else
 * the first row.
 */
export function syncRovingTabIndex(root: ParentNode): void {
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>(SIDEBAR_ROW_SELECTOR),
  );
  if (rows.length === 0) return;
  const last = lastFocusedRow.get(root);
  const stop =
    (last && rows.includes(last) ? last : undefined) ??
    rows.find((row) => row.getAttribute("aria-current") === "true") ??
    rows[0];
  for (const row of rows) {
    const want = row === stop ? "0" : "-1";
    if (row.getAttribute("tabindex") !== want) row.setAttribute("tabindex", want);
  }
}

/**
 * Keep the sidebar a single Tab stop. Rows render with `tabIndex={-1}` (a
 * constant, so React never rewrites it) and this owns which one holds `0`:
 * focusing a row moves the stop to it, and rows coming or going, or the
 * active workspace changing, re-pick it. Returns a disposer.
 */
export function installRovingRows(root: HTMLElement): () => void {
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target as Element | null;
    if (!target?.matches?.(SIDEBAR_ROW_SELECTOR)) return;
    lastFocusedRow.set(root, target as HTMLElement);
    syncRovingTabIndex(root);
  };

  const observer = new MutationObserver((records) => {
    // The active row changed (a shortcut, the palette, a click elsewhere):
    // unless the user is sitting on a row right now, the stop follows it.
    const currentChanged = records.some((r) => r.type === "attributes");
    if (currentChanged) {
      const last = lastFocusedRow.get(root);
      if (last && last !== root.ownerDocument.activeElement) {
        lastFocusedRow.delete(root);
      }
    }
    syncRovingTabIndex(root);
  });

  root.addEventListener("focusin", onFocusIn);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-current"],
  });
  syncRovingTabIndex(root);

  return () => {
    root.removeEventListener("focusin", onFocusIn);
    observer.disconnect();
    lastFocusedRow.delete(root);
  };
}

/** `installRovingRows` for the element behind `ref`, for its lifetime. */
export function useRovingRows(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return installRovingRows(root);
  }, [ref]);
}
