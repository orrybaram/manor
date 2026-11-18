/**
 * Which tabs a renderer shows, given who is holding what.
 *
 * A detached window does not *take* a tab any more — the tab stays in the
 * workspace, and the window reports a **claim** on it. The server hands every
 * renderer the same claim list on every `layout.changed`, and each one answers
 * the same question differently:
 *
 * - a **claiming window** shows the tabs it holds and nothing else;
 * - the **primary** shows everything nobody has claimed, so a popped-out tab
 *   leaves its tab bar the moment the popup reports;
 * - a **browser** shows the whole workspace, claims and all — a claim is about
 *   a desktop window's chrome, and a phone that stopped seeing a tab because
 *   somebody popped it out on the desk would be a bug, not a feature.
 *
 * Pure, and deliberately in `src/lib/` rather than in the store: it is the one
 * definition of "visible", read by the tab bar, by the panel that renders the
 * pane trees, and by `reconcileViewport`'s hidden set.
 */

import type { WorkspaceLayout } from "./workspace-layout";

/**
 * A desktop window's exclusive hold on one tab of one workspace. A window
 * holding several tabs appears once per tab.
 */
export interface LayoutClaim {
  /** The window's renderer id — `webContents.id` as a string. */
  windowId: string;
  tabId: string;
}

/** Which bridge a renderer is on; a browser is never a claimant. */
export type RendererPlatform = "electron" | "web";

/**
 * Everything that decides which tabs of one workspace a renderer shows.
 *
 * `claims` is the server's, and changes with every broadcast. `platform` is
 * the renderer's own and fixed for its life. `ownTabs` is what a detached
 * window holds: the tab it was opened with, then whatever the claims name it
 * holder of.
 */
export interface Visibility {
  claims: readonly LayoutClaim[];
  platform: RendererPlatform | undefined;
  /** The tabs this renderer holds in this workspace, or null if it is no claiming window. */
  ownTabs: ReadonlySet<string> | null;
}

/** A renderer that hides nothing: no claims, no claim of its own. */
export const SEES_EVERYTHING: Visibility = Object.freeze({
  claims: Object.freeze([]) as readonly LayoutClaim[],
  platform: undefined,
  ownTabs: null,
});

/**
 * Whether this renderer shows `tabId`.
 *
 * `ownTabs` wins over everything: a claiming window is looking at its own
 * tabs and the rest of the workspace is somebody else's business.
 */
export function isTabVisible(tabId: string, visibility: Visibility): boolean {
  const { claims, platform, ownTabs } = visibility;
  if (platform === "web") return true;
  if (ownTabs !== null) return ownTabs.has(tabId);
  return !claims.some((claim) => claim.tabId === tabId);
}

/** The tabs of `panel` this renderer shows, in the panel's own order. */
export function visibleTabsFor<T extends { id: string }>(
  panel: { tabs: readonly T[] } | null | undefined,
  visibility: Visibility,
): T[] {
  const tabs = panel?.tabs ?? [];
  return tabs.filter((tab) => isTabVisible(tab.id, visibility));
}

/**
 * Every tab of `layout` this renderer does *not* show — the set
 * {@link reconcileViewport} needs so a selection never lands on a tab that is
 * popped out somewhere else, or, in a claiming window, on any tab but its own.
 */
export function hiddenTabIdsIn(
  layout: WorkspaceLayout,
  visibility: Visibility,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (visibility.platform === "web") return hidden;
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) {
      if (!isTabVisible(tab.id, visibility)) hidden.add(tab.id);
    }
  }
  return hidden;
}

/** Whether `claims` still names `windowId` as the holder of `tabId`. */
export function holdsClaim(
  claims: readonly LayoutClaim[],
  windowId: string | null | undefined,
  tabId: string,
): boolean {
  if (windowId == null) return false;
  return claims.some(
    (claim) => claim.windowId === windowId && claim.tabId === tabId,
  );
}

/** Whether two claim lists say the same thing, order included. */
export function sameClaims(
  a: readonly LayoutClaim[],
  b: readonly LayoutClaim[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every(
    (claim, i) => claim.windowId === b[i].windowId && claim.tabId === b[i].tabId,
  );
}
