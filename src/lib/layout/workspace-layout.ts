/**
 * The structural layout model of one workspace (ADR-179 D2).
 *
 * `panelTree` → `panels{ tabs{ rootNode } }` is the whole shape: which tabs
 * exist, how their panes are split, and how the panels are arranged. It lived
 * in `src/store/app-store.ts` until ADR-179 moved it here so the Manor server
 * — not the renderer — can own it.
 *
 * What one window is *looking at* is deliberately not here: the selected tab,
 * the focused pane and the active panel are viewport, and live in
 * `./viewport.ts`, keyed by workspace and persisted per renderer (D3).
 */

import type { PaneNode } from "./pane-tree";
import { hasPaneId } from "./pane-tree";
import type { PanelNode } from "./panel-tree";

/** What a pane renders. `agent` is a terminal that auto-runs a command and is
 *  deliberately never persisted, so it is not part of this union. */
export type PaneContentType = "terminal" | "browser" | "diff";

export interface Tab {
  id: string;
  title: string;
  rootNode: PaneNode;
}

export interface Panel {
  id: string;
  tabs: Tab[];
  pinnedTabIds: string[];
}

export interface WorkspaceLayout {
  panelTree: PanelNode;
  panels: Record<string, Panel>;
}

/**
 * A layout with exactly one panel. The panel id is a parameter rather than
 * minted here: ids are decided by the sender of a layout command so it can act
 * on the result when the broadcast lands (ADR-179 D1).
 */
export function createSinglePanelLayout(
  panelId: string,
  tabs: Tab[],
  pinnedTabIds: string[],
): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: { id: panelId, tabs, pinnedTabIds },
    },
  };
}

/** The panel and tab holding `tabId`, searching every panel. */
export function findPanelWithTab(
  layout: WorkspaceLayout,
  tabId: string,
): { panel: Panel; tab: Tab } | null {
  for (const panel of Object.values(layout.panels)) {
    const tab = panel.tabs.find((t) => t.id === tabId);
    if (tab) return { panel, tab };
  }
  return null;
}

/** The panel and tab holding `paneId`, searching every panel. */
export function findPanelWithPane(
  layout: WorkspaceLayout,
  paneId: string,
): { panel: Panel; tab: Tab } | null {
  for (const panel of Object.values(layout.panels)) {
    const tab = panel.tabs.find((t) => hasPaneId(t.rootNode, paneId));
    if (tab) return { panel, tab };
  }
  return null;
}

/** One leaf of a pane tree — a pane, with what it renders. */
export type PaneLeaf = Extract<PaneNode, { type: "leaf" }>;

/**
 * Every leaf of a workspace, with the tab and panel holding it, in panel,
 * tab and tree order. The one walk over a whole layout's panes: the id set,
 * the renderer's pane index and the diff lookup are all built on it.
 */
export function* layoutLeaves(
  layout: WorkspaceLayout,
): Generator<{ panel: Panel; tab: Tab; leaf: PaneLeaf }> {
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) {
      const stack: PaneNode[] = [tab.rootNode];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.type === "leaf") yield { panel, tab, leaf: node };
        else stack.push(node.second, node.first);
      }
    }
  }
}

/** Every pane a workspace renders, across every panel and tab. */
export function layoutPaneIds(layout: WorkspaceLayout): Set<string> {
  const ids = new Set<string>();
  for (const { leaf } of layoutLeaves(layout)) ids.add(leaf.paneId);
  return ids;
}
