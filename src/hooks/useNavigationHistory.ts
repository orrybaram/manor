import { useAppStore, selectCurrentLocation } from "../store/app-store";
import type { AppState } from "../store/app-store";
import {
  useNavigationHistoryStore,
  locationsEqual,
  type Location,
} from "../store/navigation-history-store";
import { HOME_PATH } from "../lib/home-path";
import { useMountEffect } from "./useMountEffect";

/**
 * The navigator bridge between `app-store` (the source of truth for the current
 * location) and the navigation-history store. It works in both directions:
 *
 * - RECORD: subscribe to `app-store`, derive the current `Location`, and push
 *   it into history whenever it changes — but only while NOT navigating. The
 *   `isNavigating` guard is what stops replay from feeding itself: when we
 *   dispatch app-store actions to reconstruct a past location the subscription
 *   fires, but the guard suppresses the recorder so history does not grow.
 *
 * - REPLAY: `navigateBack` / `navigateForward` walk history in one direction,
 *   pruning entries that no longer map onto the live layout, and replay the
 *   first survivor by dispatching existing app-store actions.
 *
 * The history store never owns the current location; this module is the only
 * place that translates between the two representations.
 */

/** Is `loc` still reachable in the live layout? Home is always reachable. */
function isLocationValid(state: AppState, loc: Location): boolean {
  if (loc.kind === "surface") return true;
  const layout = state.workspaceLayouts[loc.workspacePath];
  if (!layout) return false;
  const panel = layout.panels[loc.panelId];
  if (!panel) return false;
  return panel.tabs.some((t) => t.id === loc.tabId);
}

/** Reconstruct a location by dispatching existing app-store actions. */
function applyLocation(loc: Location): void {
  const store = useAppStore.getState();
  if (loc.kind === "surface") {
    // Switch to Home exactly the way the sidebar does.
    store.setActiveWorkspace(HOME_PATH);
    return;
  }
  // Order matters: activate the workspace first so `focusPanel` / `selectTab`
  // resolve against the right layout, then focus the panel, then the tab.
  store.setActiveWorkspace(loc.workspacePath);
  store.focusPanel(loc.panelId);
  store.selectTab(loc.tabId);
}

/**
 * Walk history by `dir` (-1 = back, +1 = forward). Stale entries encountered
 * along the way are pruned in place; the first valid entry is applied. Stops
 * (without navigating) when a direction's end is reached with nothing valid.
 *
 * `isNavigating` is held for the whole operation — including the app-store
 * changes `applyLocation` triggers — so the recorder never re-appends the
 * location we are replaying. The guard is released on a microtask so it is
 * still up when an asynchronous subscription observes the change.
 */
function replay(dir: -1 | 1): void {
  const history = useNavigationHistoryStore;
  history.getState().setNavigating(true);
  try {
    for (;;) {
      const { entries, index } = history.getState();
      const nextIndex = index + dir;
      if (nextIndex < 0 || nextIndex >= entries.length) {
        // Hit an end of history with nothing valid to move to.
        return;
      }
      const candidate = entries[nextIndex];
      if (isLocationValid(useAppStore.getState(), candidate)) {
        history.setState({ index: nextIndex });
        applyLocation(candidate);
        return;
      }
      // Stale entry: drop it and retry in the same direction. Removing the
      // entry at `nextIndex` shifts every later index down by one, so the
      // current `index` only moves when it sat after the removed entry.
      const pruned = entries.filter((_, i) => i !== nextIndex);
      const adjustedIndex = index > nextIndex ? index - 1 : index;
      history.setState({ entries: pruned, index: adjustedIndex });
    }
  } finally {
    queueMicrotask(() => history.getState().setNavigating(false));
  }
}

/** Navigate to the previous location in history (browser-style back). */
export function navigateBack(): void {
  replay(-1);
}

/** Navigate to the next location in history (browser-style forward). */
export function navigateForward(): void {
  replay(1);
}

/**
 * Mount-once bridge. Records the initial location, then records subsequent
 * changes to the derived current location while not navigating. Call exactly
 * once, near the top of the component tree (see `App.tsx`).
 */
export function useNavigationHistory(): void {
  useMountEffect(() => {
    // Record where we start.
    let previous = selectCurrentLocation(useAppStore.getState());
    useNavigationHistoryStore.getState().record(previous);

    const unsubscribe = useAppStore.subscribe((state) => {
      const next = selectCurrentLocation(state);
      if (locationsEqual(previous, next)) return;
      previous = next;
      if (useNavigationHistoryStore.getState().isNavigating) return;
      useNavigationHistoryStore.getState().record(next);
    });

    return unsubscribe;
  });
}
