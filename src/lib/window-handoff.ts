/**
 * Moving a pane between windows (ADR-156/157) — the menu-driven twin of the
 * drag tear-off in `LeafPane`. Both go through the same store primitives:
 * serialize the pane, release its backend WITHOUT killing it, hand the payload
 * to another window, which re-attaches to the same live session by paneId.
 *
 * Also holds the "how much is left in this window" counts that the menus and
 * the popout's self-close subscription gate on.
 */

import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";

// ── Outbound handoffs in flight ─────────────────────────────────────────────
// A popout closes itself the moment its store empties (see `DetachedApp`), and
// every handoff empties the store BEFORE its payload's IPC is sent — the origin
// window has to update in the same frame or the tab visibly snaps back. Without
// this counter the close races the handoff: the window can be torn down with
// the payload still sitting in this renderer, which loses the tab and orphans
// its daemon session. Register every outbound handoff here; the self-close
// waits for the count to reach zero.

let inFlight = 0;
const idleWaiters = new Set<() => void>();

/**
 * Count `promise` as an outbound handoff for as long as it is pending. Returns
 * the same settlement, so call sites keep their own `.catch`.
 */
export function trackHandoff<T>(promise: Promise<T>): Promise<T> {
  inFlight += 1;
  return promise.finally(() => {
    inFlight -= 1;
    if (inFlight > 0) return;
    const waiters = [...idleWaiters];
    idleWaiters.clear();
    for (const waiter of waiters) waiter();
  });
}

/** Resolves once no handoff is in flight (immediately, if none ever was). */
export function whenHandoffsIdle(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.add(resolve);
  });
}

/** Total panes across every tab of every panel of this window's workspace. */
export function countPanesInWindow(): number {
  const state = useAppStore.getState();
  const path = state.activeWorkspacePath;
  if (!path) return 0;
  const layout = state.workspaceLayouts[path];
  if (!layout) return 0;
  return Object.values(layout.panels).reduce(
    (n, p) => n + p.tabs.reduce((m, t) => m + allPaneIds(t.rootNode).length, 0),
    0,
  );
}

/** Total tabs across every panel of this window's workspace. */
export function countTabsInWindow(): number {
  const state = useAppStore.getState();
  const path = state.activeWorkspacePath;
  const layout = path ? state.workspaceLayouts[path] : undefined;
  if (!layout) return 0;
  return Object.values(layout.panels).reduce((n, p) => n + p.tabs.length, 0);
}

/**
 * Tear a pane into a fresh popout window. Serialize before removing:
 * `removeDetachedPaneLocally` releases the pane's backend (pty detach / webview
 * unregister) and the payload is what the new window re-attaches from.
 */
export async function movePaneToNewWindow(paneId: string): Promise<void> {
  try {
    const payload = useAppStore.getState().serializePaneForDetach(paneId);
    const bounds = await window.electronAPI.window.getBounds();
    await window.electronAPI.window.detachTab(payload, {
      x: bounds.x + 40,
      y: bounds.y + 40,
      width: 900,
      height: 600,
    });
    useAppStore.getState().removeDetachedPaneLocally(paneId);
  } catch (err) {
    console.error("Failed to move pane to new window", err);
  }
}

/**
 * Send a pane from a popout back to the primary window. Releases the pane here
 * BEFORE the handoff so this window's `beforeunload` can't kill a session the
 * primary window now owns. Uses `reattachPane` (not `reattachTab`) so a popout
 * holding other panes stays open; when this was the last one, `DetachedApp`'s
 * empty-store subscription closes the window.
 */
export async function movePaneToMainWindow(paneId: string): Promise<void> {
  try {
    const store = useAppStore.getState();
    const payload = store.serializePaneForDetach(paneId);
    store.removeDetachedPaneLocally(paneId);
    await trackHandoff(window.electronAPI.window.reattachPane(payload));
  } catch (err) {
    console.error("Failed to move pane back to the main window", err);
  }
}
