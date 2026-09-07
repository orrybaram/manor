/**
 * A tiny listener bus for UI intents that live in component-local state
 * (ADR-170 §8).
 *
 * Several actions the native menu offers — renaming a workspace inline,
 * the merge / delete / remove-project dialogs, the notifications popover, pane
 * search, the ghosts overlay — are owned by a component's `useState`, not by a
 * store. `requestUi` lets code outside the React tree (menu handlers, for one)
 * ask the owning component to run them; the component subscribes with
 * `onUiRequest` while it is mounted.
 *
 * Generalises `palette-request.ts`, which stays as-is for the palette's own
 * view requests. Requests for an unmounted owner are dropped silently, so
 * handlers that need the sidebar visible must un-hide it first.
 */

export type UiRequest =
  | { type: "rename-workspace"; projectId: string; path: string }
  | { type: "merge-worktree"; projectId: string; path: string }
  | { type: "delete-worktree"; projectId: string; path: string }
  | { type: "remove-project"; projectId: string }
  | { type: "open-notifications" }
  | { type: "pane-search"; paneId: string }
  | { type: "ghosts" };

type Listener = (request: UiRequest) => void;

const listeners = new Set<Listener>();

/** Subscribe to UI requests. Returns an unsubscribe. */
export function onUiRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Broadcast a UI request to every mounted subscriber. */
export function requestUi(request: UiRequest): void {
  for (const listener of listeners) listener(request);
}
