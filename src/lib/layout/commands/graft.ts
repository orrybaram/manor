/**
 * The two primitives every move is made of (ADR-182 D6), and the small
 * helpers the handlers share.
 *
 * A move is `take` from the source, `graft` onto the target, and a hint for
 * the sender. `take` is also where the one empty-panel rule lives, so no
 * handler decides for itself what happens to a panel it emptied:
 *
 * - a tab whose last pane leaves goes with it;
 * - a panel whose last tab leaves goes too, while another panel remains;
 * - the last panel of all stays behind, empty — a legal state, which the
 *   renderer draws as the workspace's empty state.
 */

import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  insertSubtreeAt,
  removePane,
} from "../pane-tree";
import {
  allPanelIds,
  insertPanelSplit,
  removePanel,
} from "../panel-tree";
import type { LayoutHint } from "../viewport";
import {
  type Panel,
  type Tab,
  type WorkspaceLayout,
  findPanelWithPane,
  findPanelWithTab,
} from "../workspace-layout";
import {
  type ClosedPane,
  type LayoutResult,
  type LayoutState,
  type PaneLeaf,
  MAX_CLOSED_STACK,
} from "./types";

// ─────────────────────────────── results ────────────────────────────────

/** Nothing happened — same references out, so callers can skip a re-render. */
export function unchanged(state: LayoutState): LayoutResult {
  return { layout: state.layout, closedStack: state.closedStack, killPanes: [] };
}

export function result(
  layout: WorkspaceLayout,
  closedStack: ClosedPane[],
  hint?: LayoutHint,
  killPanes: string[] = [],
): LayoutResult {
  return { layout, closedStack, killPanes, ...(hint && { hint }) };
}

export function pushClosed(
  stack: ClosedPane[],
  entry: ClosedPane,
): ClosedPane[] {
  return [entry, ...stack].slice(0, MAX_CLOSED_STACK);
}

/** What a move tells its sender: look at the pane that just landed. */
export function landedHint(
  panelId: string,
  tabId: string,
  paneId: string,
): LayoutHint {
  return {
    selectTab: { panelId, tabId },
    focusPane: { tabId, paneId },
    activatePanel: panelId,
  };
}

// ─────────────────────────────── lookups ────────────────────────────────

/**
 * The panel a command lands in when it names none.
 *
 * "The active panel" is the sender's viewport and never reaches here, so the
 * reducer falls back to the leftmost panel in the tree — which is the right
 * answer for the one case that matters, a workspace with a single panel.
 */
export function firstPanelId(layout: WorkspaceLayout): string | undefined {
  const inTree = allPanelIds(layout.panelTree).filter(
    (id) => layout.panels[id] !== undefined,
  );
  return inTree[0] ?? Object.keys(layout.panels)[0];
}

/** The leaf for `paneId`, or null when the tree does not hold it. */
export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.first, paneId) ?? findLeaf(node.second, paneId);
}

// ─────────────────────────────── updates ────────────────────────────────

/** Replace one panel, leaving the rest of the layout by reference. */
export function withPanel(
  layout: WorkspaceLayout,
  panelId: string,
  updater: (panel: Panel) => Panel,
): WorkspaceLayout {
  const panel = layout.panels[panelId];
  if (!panel) return layout;
  return {
    ...layout,
    panels: { ...layout.panels, [panelId]: updater(panel) },
  };
}

/** Replace one tab's pane tree, wherever the tab is. */
export function withTabRoot(
  layout: WorkspaceLayout,
  tabId: string,
  rootNode: PaneNode,
): WorkspaceLayout {
  const found = findPanelWithTab(layout, tabId);
  if (!found) return layout;
  return withPanel(layout, found.panel.id, (panel) => ({
    ...panel,
    tabs: panel.tabs.map((t) => (t.id === tabId ? { ...t, rootNode } : t)),
  }));
}

/** Drop a tab from its panel, applying the empty-panel rule. */
function dropTab(
  layout: WorkspaceLayout,
  panel: Panel,
  tabId: string,
): { layout: WorkspaceLayout; panelRemoved: boolean } {
  const tabs = panel.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === 0 && Object.keys(layout.panels).length > 1) {
    const panelTree = removePanel(layout.panelTree, panel.id);
    if (panelTree) {
      const { [panel.id]: _removed, ...panels } = layout.panels;
      return { layout: { panelTree, panels }, panelRemoved: true };
    }
  }
  return {
    layout: withPanel(layout, panel.id, (p) => ({
      ...p,
      tabs,
      pinnedTabIds: p.pinnedTabIds.filter((id) => id !== tabId),
    })),
    panelRemoved: false,
  };
}

// ──────────────────────────────── take ──────────────────────────────────

export type TakeTarget = { tabId: string } | { paneId: string };

export interface Taken {
  /** The layout without what was taken. */
  layout: WorkspaceLayout;
  /** What was taken: a tab's whole tree, or one pane's leaf. */
  subtree: PaneNode;
  /** The tab it came from, as it was before the take. */
  tab: Tab;
  /** The panel it came from. */
  panelId: string;
  /** The take emptied the tab, so the tab left its panel. */
  tabRemoved: boolean;
  /** The take emptied a panel that was not the last, so the panel left too. */
  panelRemoved: boolean;
}

/** Lift a tab, or one pane, out of the layout. Null when it is not there. */
export function take(
  layout: WorkspaceLayout,
  target: TakeTarget,
): Taken | null {
  const found =
    "tabId" in target
      ? findPanelWithTab(layout, target.tabId)
      : findPanelWithPane(layout, target.paneId);
  if (!found) return null;
  const { panel, tab } = found;

  let subtree: PaneNode = tab.rootNode;
  let remaining: PaneNode | null = null;
  if ("paneId" in target) {
    const leaf = findLeaf(tab.rootNode, target.paneId);
    if (!leaf) return null;
    subtree = leaf;
    remaining = removePane(tab.rootNode, target.paneId);
  }

  const base = { subtree, tab, panelId: panel.id };
  if (remaining) {
    return {
      ...base,
      layout: withTabRoot(layout, tab.id, remaining),
      tabRemoved: false,
      panelRemoved: false,
    };
  }
  const dropped = dropTab(layout, panel, tab.id);
  return {
    ...base,
    layout: dropped.layout,
    tabRemoved: true,
    panelRemoved: dropped.panelRemoved,
  };
}

// ──────────────────────────────── graft ─────────────────────────────────

/** The id and title a grafted subtree gets when it becomes a tab. */
type TabShell = Pick<Tab, "id" | "title">;

export type GraftTarget =
  /** A split beside one pane. */
  | {
      into: "pane";
      paneId: string;
      direction: SplitDirection;
      position: "first" | "second";
    }
  /** A split of a whole tab's tree. */
  | {
      into: "tab";
      tabId: string;
      direction: SplitDirection;
      position: "first" | "second";
    }
  /** A tab of its own, at the end of a panel. */
  | { into: "panel"; panelId: string; tab: TabShell }
  /** A tab of its own, in a new panel beside another. */
  | {
      into: "new-panel";
      besidePanelId: string;
      newPanelId: string;
      direction: SplitDirection;
      tab: TabShell;
    };

/** Attach a subtree to the layout. Null when the target is not there. */
export function graft(
  layout: WorkspaceLayout,
  target: GraftTarget,
  subtree: PaneNode,
): WorkspaceLayout | null {
  switch (target.into) {
    case "pane": {
      const found = findPanelWithPane(layout, target.paneId);
      if (!found) return null;
      const rootNode = insertSubtreeAt(
        found.tab.rootNode,
        target.paneId,
        target.direction,
        subtree,
        target.position,
      );
      return withTabRoot(layout, found.tab.id, rootNode);
    }
    case "tab": {
      const found = findPanelWithTab(layout, target.tabId);
      if (!found) return null;
      const existing = found.tab.rootNode;
      const first = target.position === "first";
      return withTabRoot(layout, target.tabId, {
        type: "split",
        direction: target.direction,
        ratio: 0.5,
        first: first ? subtree : existing,
        second: first ? existing : subtree,
      });
    }
    case "panel": {
      if (!layout.panels[target.panelId]) return null;
      const tab: Tab = { ...target.tab, rootNode: subtree };
      return withPanel(layout, target.panelId, (p) => ({
        ...p,
        tabs: [...p.tabs, tab],
      }));
    }
    case "new-panel": {
      if (!layout.panels[target.besidePanelId]) return null;
      const tab: Tab = { ...target.tab, rootNode: subtree };
      return {
        panelTree: insertPanelSplit(
          layout.panelTree,
          target.besidePanelId,
          target.direction,
          target.newPanelId,
        ),
        panels: {
          ...layout.panels,
          [target.newPanelId]: {
            id: target.newPanelId,
            tabs: [tab],
            pinnedTabIds: [],
          },
        },
      };
    }
  }
}

/**
 * `take` then `graft`, or null when either end is missing — in which case
 * the command is a no-op and nothing of the take survives.
 */
export function transplant(
  layout: WorkspaceLayout,
  from: TakeTarget,
  to: GraftTarget,
): { taken: Taken; layout: WorkspaceLayout } | null {
  const taken = take(layout, from);
  if (!taken) return null;
  const next = graft(taken.layout, to, taken.subtree);
  return next ? { taken, layout: next } : null;
}

/** The pane a subtree would focus: its first. */
export function firstPaneOf(subtree: PaneNode): string {
  return allPaneIds(subtree)[0];
}
