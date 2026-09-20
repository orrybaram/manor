/**
 * Serializable snapshot of one workspace's layout, for introspection by the
 * MCP `list_panes` tool and `GET /panes` (ADR-152, ADR-179 D5).
 *
 * This is the single declaration of the snapshot shape: `electron/mcp/`
 * imports `LayoutSnapshot` from here type-only, so the two processes cannot
 * drift. Pure — no store, no renderer — so the Manor server builds it
 * straight from `LayoutStore.get()` and `primaryViewport()` (ADR-179 D5),
 * with no window involved at all.
 *
 * Focus and activation are recorded **once**, at the top level. A tab's
 * `focusedPaneId` is per-tab state — it says which pane that tab would focus
 * if it were the active tab — and is not a claim about global focus.
 */

import { allPaneIds } from "./pane-tree";
import { allPanelIds } from "./panel-tree";
import type { PaneNode } from "./pane-tree";
import type { WorkspaceLayout } from "./workspace-layout";
import { focusedPaneOf, selectedTabOf, type WorkspaceViewport } from "./viewport";

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
  /** The one active tab, across every panel. Null with no reported viewport. */
  activeTabId: string | null;
  /** The one focused pane, in the active panel's active tab. Null with no
   *  reported viewport. */
  focusedPaneId: string | null;
  tabs: TabSnapshot[];
}

/** A tab's panes, depth-first left-to-right, straight from the tree's own
 *  leaf fields — contentType and url are structure (ADR-179 D3). */
function paneSnapshots(node: PaneNode): PaneSnapshot[] {
  if (node.type === "leaf") {
    const contentType = node.contentType ?? "terminal";
    return [
      {
        paneId: node.paneId,
        contentType,
        ...(contentType === "browser" && node.url !== undefined && {
          url: node.url,
        }),
      },
    ];
  }
  return [...paneSnapshots(node.first), ...paneSnapshots(node.second)];
}

/**
 * Snapshot a workspace's layout, listing every tab in every panel.
 *
 * `viewport` is null when no window has reported one for this workspace yet
 * (ADR-179 D5) — the top-level `activeTabId`/`focusedPaneId` are then null,
 * and each tab's own `focusedPaneId` falls back to its first pane.
 */
export function buildLayoutSnapshot(
  workspacePath: string,
  layout: WorkspaceLayout,
  viewport: WorkspaceViewport | null,
): LayoutSnapshot {
  const activeTabId = viewport
    ? selectedTabOf(viewport, viewport.activePanelId)
    : null;
  const focusedPaneId = viewport ? focusedPaneOf(viewport, activeTabId) : null;

  const tabs: TabSnapshot[] = [];
  for (const panelId of allPanelIds(layout.panelTree)) {
    const panel = layout.panels[panelId];
    if (!panel) continue;
    for (const tab of panel.tabs) {
      const panes = paneSnapshots(tab.rootNode);
      const tabFocusedPaneId =
        (viewport ? focusedPaneOf(viewport, tab.id) : null) ??
        allPaneIds(tab.rootNode)[0];
      tabs.push({
        tabId: tab.id,
        title: tab.title,
        focusedPaneId: tabFocusedPaneId,
        panes,
      });
    }
  }

  return { workspacePath, activeTabId, focusedPaneId, tabs };
}
