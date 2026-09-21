/**
 * Popping a tab or a pane out into a window of its own (ADR-179 D4).
 *
 * What this replaces is worth stating, because the shape of the code changed
 * completely: ADR-156/157 moved a tab *out* of the workspace by serializing
 * it, releasing its sessions, and handing a payload to another window, which
 * rebuilt it. Under a server-owned layout there is nothing to move. The tab
 * stays exactly where it is — a browser goes on seeing it, `GET /panes` goes
 * on listing it — and the new window boots the ordinary renderer with a
 * **claim** on it. The primary stops drawing the tab because the server told
 * it who holds what, not because anything left.
 *
 * So a detach is: (optionally) one layout command to make the tab, then one
 * IPC to open a window pointed at it. Coming back is smaller still: the
 * window closes, the claim dies with it, and the tab is already there.
 */

import { useAppStore, OWN_CLAIM } from "../store/app-store";
import { allPaneIds } from "./layout/pane-tree";
import {
  findPanelWithPane,
  findPanelWithTab,
} from "./layout/workspace-layout";

/** Bounds a torn-off tab's new window opens with. */
export interface SpawnBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const POPOUT_SIZE = { width: 900, height: 600 };

/** The workspace a tab belongs to, searching every layout this window holds. */
function workspaceOfTab(tabId: string): string | null {
  const { workspaceLayouts } = useAppStore.getState();
  for (const [path, layout] of Object.entries(workspaceLayouts)) {
    if (findPanelWithTab(layout, tabId)) return path;
  }
  return null;
}

/** The workspace a pane belongs to. */
function workspaceOfPane(paneId: string): string | null {
  const { workspaceLayouts } = useAppStore.getState();
  for (const [path, layout] of Object.entries(workspaceLayouts)) {
    if (findPanelWithPane(layout, paneId)) return path;
  }
  return null;
}

/** Open a window that claims `tabId` of `workspacePath`. */
async function openClaimWindow(
  workspacePath: string,
  tabId: string,
  spawnBounds?: SpawnBounds,
): Promise<void> {
  let bounds = spawnBounds;
  if (!bounds) {
    const own = await window.electronAPI.window.getBounds();
    bounds = { x: own.x + 40, y: own.y + 40, ...POPOUT_SIZE };
  }
  await window.electronAPI.window.detachTab(workspacePath, tabId, bounds);
}

/** Whether this window is a detached one, holding a single claimed tab. */
export function hasOwnClaim(): boolean {
  return OWN_CLAIM !== null;
}

/**
 * Panes of the tab this window claims — 0 when it claims nothing.
 *
 * The gate on "would tearing this out leave an empty window?", which used to
 * be a count across the popout's whole private store and is now simply the
 * size of the one tab it shows.
 */
export function panesInOwnClaim(): number {
  if (!OWN_CLAIM) return 0;
  const layout = useAppStore.getState().workspaceLayouts[OWN_CLAIM.workspacePath];
  if (!layout) return 0;
  const found = findPanelWithTab(layout, OWN_CLAIM.tabId);
  return found ? allPaneIds(found.tab.rootNode).length : 0;
}

/**
 * Open a window holding `tabId`. `spawnBounds` is where a drag released it;
 * without one the new window is offset from this one.
 */
export async function detachTabToNewWindow(
  tabId: string,
  spawnBounds?: SpawnBounds,
): Promise<void> {
  try {
    const workspacePath = workspaceOfTab(tabId);
    if (!workspacePath) return;
    await openClaimWindow(workspacePath, tabId, spawnBounds);
  } catch (err) {
    console.error("Failed to move tab to a new window", err);
  }
}

/**
 * Pop one pane out: make it a tab, then claim that tab.
 *
 * `extractPaneToTab` mints the new tab's id itself and returns it before the
 * server has answered (the id is the sender's, D1), so the window can be
 * opened in the same breath — it will not report its claim until it has
 * booted, by which time the tab is in the tree.
 */
export async function movePaneToNewWindow(
  paneId: string,
  spawnBounds?: SpawnBounds,
): Promise<void> {
  try {
    // The workspace is read from the *pane*, which is in the tree right now;
    // the tab the command creates is not there yet, and will not be until the
    // broadcast lands. The new window claims it either way — a claim on a tab
    // the server has not made yet is kept, not dropped (D4).
    const workspacePath = workspaceOfPane(paneId);
    if (!workspacePath) return;
    const tabId = useAppStore.getState().extractPaneToTab(paneId);
    if (!tabId) return;
    await openClaimWindow(workspacePath, tabId, spawnBounds);
  } catch (err) {
    console.error("Failed to move pane to a new window", err);
  }
}

/**
 * Give the tab back to the primary: close this window.
 *
 * That is the whole operation (D4). The claim is released by the window
 * dying, the server broadcasts claims without it, and the primary draws the
 * tab again — same panes, same sessions, nothing re-attached.
 */
export function returnToPrimaryWindow(): void {
  window.electronAPI.window.closeSelf();
}
