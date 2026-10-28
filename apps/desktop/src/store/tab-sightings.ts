import { useSyncExternalStore } from "react";
import { useAppStore, type AppState } from "./app-store";
import { allTabIds, createTabSightings, frontTabIds, type TabReturn } from "../lib/cobwebs";

// One tracker for the window, so a tab's last sighting outlives its
// TabButton (which unmounts whenever its workspace is not the active one).
// It only listens to the store while something shows dust or webs.
let sightings = createTabSightings();
let unsubscribe: (() => void) | null = null;
let holders = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function observe(state: AppState): void {
  sightings.update(frontTabIds(state.viewports), allTabIds(state.workspaceLayouts), Date.now());
}

function retain(): () => void {
  clearTimeout(releaseTimer);
  if (holders++ === 0 && !unsubscribe) {
    sightings = createTabSightings();
    observe(useAppStore.getState());
    unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.viewports === previous.viewports && state.workspaceLayouts === previous.workspaceLayouts) {
        return;
      }
      observe(state);
    });
  }
  return () => {
    if (--holders > 0) return;
    // A workspace switch unmounts every tab before the next workspace's
    // mount; a short grace keeps the ages through it.
    releaseTimer = setTimeout(() => {
      if (holders > 0) return;
      unsubscribe?.();
      unsubscribe = null;
    }, 5_000);
  };
}

const noop = () => () => {};
const snapshot = () => 0;

/** Keep tab ages tracked while `active`; stops costing anything once nobody needs them. */
export function useTabSightings(active: boolean): void {
  useSyncExternalStore(active ? retain : noop, snapshot);
}

/** The tab's latest return to the front in this window, and how long it had been away. */
export function tabLastReturn(tabId: string): TabReturn | undefined {
  return sightings.lastReturn(tabId);
}

/** Milliseconds since the tab was last on show in this window; 0 while it is. */
export function tabUnseenFor(tabId: string, now: number): number {
  return sightings.unseenFor(tabId, now);
}
