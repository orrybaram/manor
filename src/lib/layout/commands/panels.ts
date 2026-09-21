/** Panel commands: split, close, resize, and moving tabs between panels. */

import { allPaneIds } from "../pane-tree";
import {
  allPanelIds,
  insertPanelSplit,
  nextPanelId,
  removePanel,
  updatePanelRatio as updatePanelRatioInTree,
} from "../panel-tree";
import {
  createSinglePanelLayout,
  findPanelWithTab,
} from "../workspace-layout";
import { firstPaneOf, result, transplant, unchanged } from "./graft";
import type { CommandOf, LayoutResult, LayoutState } from "./types";

/**
 * A new panel beside `panelId`, holding the tab it names.
 *
 * Splitting off a panel's only tab is a no-op: moving it out would empty the
 * panel, which the empty-panel rule then removes, leaving nothing split. The
 * desktop sends `split-panel-with-new-tab` for that case instead. A panel
 * with no tabs at all splits into an empty panel beside it.
 */
export function splitPanel(
  state: LayoutState,
  command: CommandOf<"split-panel">,
): LayoutResult {
  const { layout, closedStack } = state;
  const panel = layout.panels[command.panelId];
  if (!panel) return unchanged(state);

  const movedId = command.tabId ?? panel.tabs[0]?.id;
  const moved = panel.tabs.find((t) => t.id === movedId);
  if (moved && panel.tabs.length === 1) return unchanged(state);
  if (moved) {
    const next = transplant(
      layout,
      { tabId: moved.id },
      {
        into: "new-panel",
        besidePanelId: panel.id,
        newPanelId: command.newPanelId,
        direction: command.direction,
        tab: { id: moved.id, title: moved.title },
      },
    );
    if (!next) return unchanged(state);
    return result(next.layout, closedStack, {
      selectTab: { panelId: command.newPanelId, tabId: moved.id },
      activatePanel: command.newPanelId,
    });
  }

  return result(
    {
      panelTree: insertPanelSplit(
        layout.panelTree,
        panel.id,
        command.direction,
        command.newPanelId,
      ),
      panels: {
        ...layout.panels,
        [command.newPanelId]: {
          id: command.newPanelId,
          tabs: [],
          pinnedTabIds: [],
        },
      },
    },
    closedStack,
    { activatePanel: command.newPanelId },
  );
}

/**
 * Close a panel and every pane in it. The last panel of all stays behind,
 * empty and under its own id — the same state the empty-panel rule leaves.
 */
export function closePanel(
  state: LayoutState,
  command: CommandOf<"close-panel">,
): LayoutResult {
  const { layout, closedStack } = state;
  const panel = layout.panels[command.panelId];
  if (!panel) return unchanged(state);

  const killPanes = panel.tabs.flatMap((tab) => allPaneIds(tab.rootNode));
  const panelTree = removePanel(layout.panelTree, command.panelId);

  if (panelTree === null) {
    return result(
      createSinglePanelLayout(command.panelId, [], []),
      closedStack,
      { activatePanel: command.panelId },
      killPanes,
    );
  }

  const { [command.panelId]: _removed, ...panels } = layout.panels;
  const activatePanel =
    nextPanelId(panelTree, command.panelId) ?? allPanelIds(panelTree)[0];
  return result(
    { panelTree, panels },
    closedStack,
    activatePanel ? { activatePanel } : undefined,
    killPanes,
  );
}

export function updatePanelRatio(
  state: LayoutState,
  command: CommandOf<"update-panel-ratio">,
): LayoutResult {
  const { layout } = state;
  const panelTree = updatePanelRatioInTree(
    layout.panelTree,
    command.firstPanelId,
    command.ratio,
  );
  if (panelTree === layout.panelTree) return unchanged(state);
  return result({ ...layout, panelTree }, state.closedStack);
}

export function moveTabToPanel(
  state: LayoutState,
  command: CommandOf<"move-tab-to-panel">,
): LayoutResult {
  const source = findPanelWithTab(state.layout, command.tabId);
  if (!source || source.panel.id === command.targetPanelId) {
    return unchanged(state);
  }
  const { tab } = source;
  const moved = transplant(
    state.layout,
    { tabId: tab.id },
    {
      into: "panel",
      panelId: command.targetPanelId,
      tab: { id: tab.id, title: tab.title },
    },
  );
  if (!moved) return unchanged(state);
  return result(moved.layout, state.closedStack, {
    selectTab: { panelId: command.targetPanelId, tabId: tab.id },
    activatePanel: command.targetPanelId,
  });
}

/**
 * A tab dropped on a panel's edge: a new panel beside the target, holding it.
 * Dropping a panel's only tab on that same panel is a no-op — there is
 * nothing to split it from.
 */
export function splitPanelWithTab(
  state: LayoutState,
  command: CommandOf<"split-panel-with-tab">,
): LayoutResult {
  const source = findPanelWithTab(state.layout, command.tabId);
  if (!source) return unchanged(state);
  const { panel, tab } = source;
  if (panel.id === command.targetPanelId && panel.tabs.length === 1) {
    return unchanged(state);
  }
  const moved = transplant(
    state.layout,
    { tabId: tab.id },
    {
      into: "new-panel",
      besidePanelId: command.targetPanelId,
      newPanelId: command.newPanelId,
      direction: command.direction,
      tab: { id: tab.id, title: tab.title },
    },
  );
  if (!moved) return unchanged(state);
  return result(moved.layout, state.closedStack, {
    selectTab: { panelId: command.newPanelId, tabId: tab.id },
    activatePanel: command.newPanelId,
  });
}

export function splitPanelWithNewTab(
  state: LayoutState,
  command: CommandOf<"split-panel-with-new-tab">,
): LayoutResult {
  const { layout, closedStack } = state;
  if (!layout.panels[command.sourcePanelId]) return unchanged(state);
  return result(
    {
      panelTree: insertPanelSplit(
        layout.panelTree,
        command.sourcePanelId,
        command.direction,
        command.newPanelId,
      ),
      panels: {
        ...layout.panels,
        [command.newPanelId]: {
          id: command.newPanelId,
          tabs: [command.tab],
          pinnedTabIds: [],
        },
      },
    },
    closedStack,
    {
      selectTab: { panelId: command.newPanelId, tabId: command.tab.id },
      focusPane: {
        tabId: command.tab.id,
        paneId: firstPaneOf(command.tab.rootNode),
      },
      activatePanel: command.newPanelId,
    },
  );
}
