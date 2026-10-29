import type { WorkspaceViewport } from "./layout/viewport";
import type { WorkspaceLayout } from "./layout/workspace-layout";

/**
 * Halloween cobwebs: during Halloween week, a tab nobody has looked at for a
 * while gathers dust, and its panel opens under cobwebs the mouse sweeps away.
 */

/** Set to "1" in localStorage to see the effects on any day. */
export const HALLOWEEN_OVERRIDE_KEY = "manor:halloween";

export type CobwebLevel = 0 | 1 | 2 | 3;

/** Minutes unseen before a tab reaches each level. */
const LEVEL_THRESHOLDS_MIN: readonly [number, number, number] = [2, 10, 30];

/** Oct 25 through Nov 1, by the local date. */
export function isHalloweenWeek(now: Date): boolean {
  const month = now.getMonth();
  const day = now.getDate();
  if ((month === 9 && day >= 25) || (month === 10 && day === 1)) return true;
  try {
    return localStorage.getItem(HALLOWEEN_OVERRIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function cobwebLevel(unseenMs: number): CobwebLevel {
  const minutes = unseenMs / 60_000;
  const [small, medium, large] = LEVEL_THRESHOLDS_MIN;
  if (minutes >= large) return 3;
  if (minutes >= medium) return 2;
  if (minutes >= small) return 1;
  return 0;
}

/** The tabs on show: the selected tab of every panel, in every workspace. */
export function frontTabIds(
  viewports: Record<string, WorkspaceViewport>,
): Set<string> {
  const ids = new Set<string>();
  for (const viewport of Object.values(viewports)) {
    for (const tabId of Object.values(viewport.selectedTabIds)) ids.add(tabId);
  }
  return ids;
}

/** Every tab in every workspace's layout. */
export function allTabIds(layouts: Record<string, WorkspaceLayout>): Set<string> {
  const ids = new Set<string>();
  for (const layout of Object.values(layouts)) {
    for (const panel of Object.values(layout.panels)) {
      for (const tab of panel.tabs) ids.add(tab.id);
    }
  }
  return ids;
}

/**
 * When each tab was last on show. A tab first seen off the front counts from
 * that moment, so a new tab, or one that was open when tracking began, starts
 * clean.
 */
/** A tab coming back to the front: when, and after how long unseen. */
export type TabReturn = { at: number; unseenMs: number };

export function createTabSightings() {
  const lastSeen = new Map<string, number>();
  const returns = new Map<string, TabReturn>();
  let front = new Set<string>();
  return {
    /**
     * Record the tabs on show now (`next`) among all open tabs (`all`): any
     * that just left the front were seen now, and closed tabs are forgotten.
     */
    update(next: Set<string>, all: Set<string>, now: number): void {
      for (const tabId of front) {
        if (!next.has(tabId)) lastSeen.set(tabId, now);
      }
      for (const tabId of next) {
        if (front.has(tabId)) continue;
        const seen = lastSeen.get(tabId);
        returns.set(tabId, { at: now, unseenMs: seen === undefined ? 0 : Math.max(0, now - seen) });
      }
      for (const tabId of all) {
        if (!next.has(tabId) && !lastSeen.has(tabId)) lastSeen.set(tabId, now);
      }
      for (const tabId of lastSeen.keys()) {
        if (!all.has(tabId)) lastSeen.delete(tabId);
      }
      for (const tabId of returns.keys()) {
        if (!all.has(tabId)) returns.delete(tabId);
      }
      front = next;
    },
    /** The tab's latest return to the front, if it has come back since tracking began. */
    lastReturn(tabId: string): TabReturn | undefined {
      return returns.get(tabId);
    },
    /** Milliseconds since the tab was last on show; 0 while it is, or if unknown. */
    unseenFor(tabId: string, now: number): number {
      if (front.has(tabId)) return 0;
      const seen = lastSeen.get(tabId);
      return seen === undefined ? 0 : Math.max(0, now - seen);
    },
  };
}
