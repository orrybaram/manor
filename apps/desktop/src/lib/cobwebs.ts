import type { WorkspaceViewport } from "./layout/viewport";

/**
 * Halloween cobwebs: during Halloween week, a tab nobody has looked at for a
 * while gathers dust, and its panel opens under cobwebs the mouse sweeps away.
 */

/** Set to "1" in localStorage to see the effects on any day. */
export const HALLOWEEN_OVERRIDE_KEY = "manor:halloween";

export type CobwebLevel = 0 | 1 | 2 | 3;

/** Minutes unseen before a tab reaches each level. */
const LEVEL_THRESHOLDS_MIN: readonly [number, number, number] = [5, 20, 60];

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

/**
 * When each tab was last on show. A tab never seen leaving the front counts
 * from `startedAt`, so every tab starts clean when the window opens.
 */
export function createTabSightings(startedAt: number) {
  const lastSeen = new Map<string, number>();
  let front = new Set<string>();
  return {
    /** Record the tabs on show now; any that just left the front were seen now. */
    update(next: Set<string>, now: number): void {
      for (const tabId of front) {
        if (!next.has(tabId)) lastSeen.set(tabId, now);
      }
      front = next;
    },
    /** Milliseconds since the tab was last on show; 0 while it is. */
    unseenFor(tabId: string, now: number): number {
      if (front.has(tabId)) return 0;
      return Math.max(0, now - (lastSeen.get(tabId) ?? startedAt));
    },
  };
}
