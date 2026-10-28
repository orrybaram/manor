import { useAppStore } from "./app-store";
import { createTabSightings, frontTabIds } from "../lib/cobwebs";

// One tracker for the window: a tab's last sighting has to outlive its
// TabButton, which unmounts whenever its workspace is not the active one.
const sightings = createTabSightings(Date.now());
sightings.update(frontTabIds(useAppStore.getState().viewports), Date.now());
useAppStore.subscribe((state, previous) => {
  if (state.viewports === previous.viewports) return;
  sightings.update(frontTabIds(state.viewports), Date.now());
});

/** Milliseconds since the tab was last on show in this window; 0 while it is. */
export function tabUnseenFor(tabId: string, now: number): number {
  return sightings.unseenFor(tabId, now);
}
