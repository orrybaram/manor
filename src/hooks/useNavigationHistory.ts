import { useAppStore, selectCurrentLocation } from "../store/app-store";
import type { AppState } from "../store/app-store";
import {
  useNavigationHistoryStore,
  locationsEqual,
  type Location,
} from "../store/navigation-history-store";
import { HOME_PATH } from "../lib/home-path";
import { useProjectStore } from "../store/project-store";
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
  // An empty workspace has no tab, so its recorded `tabId` is "". That is a
  // legitimate view (the empty-workspace surface), not a stale coordinate:
  // treat it as valid while the panel is still empty. Without this, every
  // empty workspace gets pruned on back/forward and silently skipped.
  if (loc.tabId === "") return panel.tabs.length === 0;
  return panel.tabs.some((t) => t.id === loc.tabId);
}

/** Reconstruct a location by dispatching existing app-store actions. */
function applyLocation(loc: Location): void {
  const store = useAppStore.getState();
  if (loc.kind === "surface") {
    // Switch to Home exactly the way the sidebar does. Home highlighting is
    // driven by `activeWorkspacePath`, so this alone updates the sidebar.
    store.setActiveWorkspace(HOME_PATH);
    return;
  }
  // Activate the workspace the SAME way the sidebar does: through
  // `project-store.selectWorkspace`, which updates the project-store selection
  // (what the sidebar highlights) AND calls `setActiveWorkspace`. Going through
  // `setActiveWorkspace` alone leaves the sidebar pointed at the old workspace,
  // so replaying between two empty workspaces looks like nothing happened.
  const projects = useProjectStore.getState().projects;
  const project = projects.find((p) =>
    p.workspaces.some((w) => w.path === loc.workspacePath),
  );
  if (project) {
    const wsIndex = project.workspaces.findIndex(
      (w) => w.path === loc.workspacePath,
    );
    useProjectStore.getState().selectWorkspace(project.id, wsIndex);
  } else {
    // Fallback: path not owned by any project (shouldn't happen post-prune).
    store.setActiveWorkspace(loc.workspacePath);
  }
  // Then focus the recorded panel and tab within that workspace.
  useAppStore.getState().focusPanel(loc.panelId);
  useAppStore.getState().selectTab(loc.tabId);
}

/**
 * Move through history in `dir` (-1 = back, +1 = forward) and reconstruct the
 * resulting location. The store owns the walk-and-prune; this only supplies the
 * layout-validity predicate and applies the survivor.
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
    const target = history
      .getState()
      .navigate(dir, (loc) => isLocationValid(useAppStore.getState(), loc));
    if (target) applyLocation(target);
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
