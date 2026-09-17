/**
 * Focus regions (ADR-175): the handful of top-level areas keyboard focus can
 * jump between with F6 / Shift+F6, ⌘⇧E (sidebar) and ⌘⇧Y (tab bar).
 *
 * Each region's root element carries `data-focus-region="<name>"`. Regions can
 * nest (a tab bar sits inside a panel), so the region that "holds" focus is the
 * innermost one around `document.activeElement`.
 *
 * A region takes part in cycling only when it is in the DOM, visible, and has
 * something to focus. The pane region is special: focusing it means asking the
 * active pane to take the keyboard (`refocusActivePane`), not calling
 * `.focus()` on an element.
 */

import { useAppStore } from "../store/app-store";
import { SIDEBAR_ROW_SELECTOR } from "./sidebar-row";

export type FocusRegion = "sidebar" | "tabbar" | "pane" | "statusbar";

export const REGION_ATTR = "data-focus-region";

/** Cycle order for F6. Shift+F6 walks it backwards. */
export const REGION_ORDER: readonly FocusRegion[] = [
  "sidebar",
  "tabbar",
  "pane",
  "statusbar",
];

const SELECTED_TAB = '[role="tab"][aria-selected="true"]';
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isRegion(value: string | undefined): value is FocusRegion {
  return (REGION_ORDER as readonly string[]).includes(value ?? "");
}

/**
 * Rendered and not hidden. `visibility` is inherited, so a region inside a
 * hidden workspace layer reports `hidden` itself.
 */
function isVisible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  return view.getComputedStyle(el).visibility !== "hidden";
}

function regionRoots(region: FocusRegion): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[${REGION_ATTR}="${region}"]`),
  ).filter(isVisible);
}

/** The region holding keyboard focus, or null when focus is outside all of them. */
export function currentRegion(): FocusRegion | null {
  const active = document.activeElement;
  const root = active?.closest<HTMLElement>(`[${REGION_ATTR}]`);
  const name = root?.getAttribute(REGION_ATTR) ?? undefined;
  return isRegion(name) ? name : null;
}

/**
 * True while focus sits in a navigation region — anywhere but the pane. The
 * terminal's auto-focus effect uses this to leave focus where the user put it.
 */
export function isNavRegionFocused(): boolean {
  const region = currentRegion();
  return region !== null && region !== "pane";
}

/** The element the sidebar hands focus to: the active row, else the first. */
function sidebarTarget(roots: HTMLElement[]): HTMLElement | null {
  const rows = roots.flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(SIDEBAR_ROW_SELECTOR)),
  );
  if (rows.length === 0) return null;
  const activePath = useAppStore.getState().activeWorkspacePath;
  const activeRow = rows.find(
    (row) =>
      row.getAttribute("aria-current") === "true" ||
      (activePath !== null &&
        row.getAttribute("data-workspace-path") === activePath),
  );
  return (
    activeRow ??
    rows.find((row) => row.getAttribute("tabindex") === "0") ??
    rows[0]
  );
}

/**
 * The selected tab of the active panel. Split panels each render a tab bar, so
 * prefer the one whose selected tab is the active panel's.
 */
function tabbarTarget(roots: HTMLElement[]): HTMLElement | null {
  const tabs = roots.flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(SELECTED_TAB)),
  );
  if (tabs.length === 0) return null;
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[state.activeWorkspacePath ?? ""];
  const selectedTabId = layout?.panels[layout.activePanelId]?.selectedTabId;
  return (
    tabs.find((tab) => tab.getAttribute("data-tab-id") === selectedTabId) ??
    tabs[0]
  );
}

function statusbarTarget(roots: HTMLElement[]): HTMLElement | null {
  for (const root of roots) {
    const target = Array.from(
      root.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).find(isVisible);
    if (target) return target;
  }
  return null;
}

/**
 * Move focus into `region`. Returns false (and leaves focus alone) when the
 * region is absent, hidden, or has nothing to focus.
 */
export function focusRegion(region: FocusRegion): boolean {
  const roots = regionRoots(region);
  if (roots.length === 0) return false;

  if (region === "pane") {
    // The pane's own auto-focus effect puts the keyboard in the terminal. Drop
    // DOM focus from the nav region first so nothing there holds on to it.
    if (isNavRegionFocused()) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    useAppStore.getState().refocusActivePane();
    return true;
  }

  const target =
    region === "sidebar"
      ? sidebarTarget(roots)
      : region === "tabbar"
        ? tabbarTarget(roots)
        : statusbarTarget(roots);
  if (!target) return false;
  target.focus();
  return true;
}

/**
 * Step to the next (`1`) or previous (`-1`) region that can take focus,
 * wrapping around and skipping unavailable ones. From outside every region the
 * walk starts before the first (forward) or after the last (backward).
 *
 * `from` overrides the region focus is taken to be in — for a web page, whose
 * `<webview>` has just been blurred so the pane no longer holds DOM focus.
 */
export function cycleRegion(
  delta: 1 | -1,
  from: FocusRegion | null = currentRegion(),
): FocusRegion | null {
  const count = REGION_ORDER.length;
  const current = from;
  const start = current
    ? REGION_ORDER.indexOf(current)
    : delta === 1
      ? -1
      : count;
  for (let step = 1; step <= count; step++) {
    const index = (((start + delta * step) % count) + count) % count;
    const region = REGION_ORDER[index];
    if (region === current) return null;
    if (focusRegion(region)) return region;
  }
  return null;
}

/**
 * Focus `region` once it can take focus, waiting up to `frames` animation
 * frames — for callers that just un-hid the region (or closed a dialog) and
 * need React to commit first.
 */
export function focusRegionWhenReady(region: FocusRegion, frames = 10): void {
  const attempt = (left: number) => {
    if (focusRegion(region) || left <= 0) return;
    requestAnimationFrame(() => attempt(left - 1));
  };
  requestAnimationFrame(() => attempt(frames));
}
