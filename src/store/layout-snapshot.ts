/**
 * Serializable snapshot of the active workspace's layout, for introspection by
 * the MCP `list_panes` tool (see ADR-152).
 *
 * This is the single declaration of the snapshot shape: `electron/mcp/` imports
 * `LayoutSnapshot` from here type-only, so the two processes cannot drift.
 *
 * Focus and activation are recorded **once**, at the top level. A tab's
 * `focusedPaneId` is per-tab state — it says which pane that tab would focus if
 * it were the active tab — and is not a claim about global focus.
 */

import type { AppState } from "./app-store";
import { allPaneIds } from "./pane-tree";
import { allPanelIds } from "./panel-tree";

/** Serializable snapshot of a single pane. */
export interface PaneSnapshot {
  paneId: string;
  contentType: "terminal" | "browser" | "diff";
  url?: string;
}

/** Serializable snapshot of a tab. */
export interface TabSnapshot {
  tabId: string;
  title: string;
  focusedPaneId: string;
  panes: PaneSnapshot[];
}

export interface LayoutSnapshot {
  workspacePath: string;
  /** The one active tab, across every panel. */
  activeTabId: string | null;
  /** The one focused pane, in the active panel's active tab. */
  focusedPaneId: string | null;
  tabs: TabSnapshot[];
}

/**
 * Snapshot the active workspace's layout, listing every tab in every panel.
 *
 * `contentType` and `url` are resolved from the store's `paneContentType` /
 * `paneUrl` maps (the source of truth) — not from the tree leaf's inline
 * fields, which `swapSiblings` and `updateLeafContentType` discard.
 *
 * Returns null when there is no active workspace.
 */
export function layoutSnapshot(state: AppState): LayoutSnapshot | null {
  const workspacePath = state.activeWorkspacePath;
  if (!workspacePath) return null;
  const layout = state.workspaceLayouts[workspacePath];
  if (!layout) return null;

  const activePanel = layout.panels[layout.activePanelId];
  const activeTabId = activePanel?.selectedTabId ?? null;
  const activeTab = activePanel?.tabs.find((tab) => tab.id === activeTabId);
  const focusedPaneId = activeTab?.focusedPaneId ?? null;

  const tabs: TabSnapshot[] = [];
  for (const panelId of allPanelIds(layout.panelTree)) {
    const panel = layout.panels[panelId];
    if (!panel) continue;
    for (const tab of panel.tabs) {
      tabs.push({
        tabId: tab.id,
        title: tab.title,
        focusedPaneId: tab.focusedPaneId,
        panes: allPaneIds(tab.rootNode).map((paneId) => {
          const contentType = state.paneContentType[paneId] ?? "terminal";
          const url = state.paneUrl[paneId];
          return {
            paneId,
            contentType,
            ...(contentType === "browser" && url !== undefined && { url }),
          };
        }),
      });
    }
  }

  return { workspacePath, activeTabId, focusedPaneId, tabs };
}
