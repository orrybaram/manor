/** Pane commands: split, move, extract, close, reopen, and leaf edits. */

import {
  allPaneIds,
  hasPaneId,
  insertSplitAt,
  insertSubtreeAt,
  movePane as movePaneInTree,
  updateLeafContentType,
  updateLeafUrl,
  updateRatio,
} from "../pane-tree";
import { insertPanelSplit } from "../panel-tree";
import {
  type Panel,
  type Tab,
  findPanelWithPane,
  findPanelWithTab,
} from "../workspace-layout";
import {
  firstPaneOf,
  firstPanelId,
  graft,
  landedHint,
  pushClosed,
  result,
  take,
  transplant,
  unchanged,
  withPanel,
  withTabRoot,
} from "./graft";
import { closeTab } from "./tabs";
import type {
  ClosedPaneEntry,
  CommandOf,
  LayoutResult,
  LayoutState,
  PaneLeaf,
} from "./types";

export function splitPaneAt(
  state: LayoutState,
  command: CommandOf<"split-pane-at">,
): LayoutResult {
  const found = findPanelWithPane(state.layout, command.paneId);
  if (!found) return unchanged(state);
  const rootNode = insertSplitAt(
    found.tab.rootNode,
    command.paneId,
    command.direction,
    command.newPaneId,
    command.position,
    command.contentType,
    command.url,
  );
  return result(withTabRoot(state.layout, found.tab.id, rootNode), state.closedStack, {
    focusPane: { tabId: found.tab.id, paneId: command.newPaneId },
  });
}

export function movePane(
  state: LayoutState,
  command: CommandOf<"move-pane">,
): LayoutResult {
  const { sourcePaneId, targetPaneId, direction, position } = command;
  const source = findPanelWithPane(state.layout, sourcePaneId);
  const target = findPanelWithPane(state.layout, targetPaneId);
  if (!source || !target) return unchanged(state);
  const hint = landedHint(target.panel.id, target.tab.id, sourcePaneId);

  // Same tab — a reshuffle inside one tree, where two siblings swap rather
  // than nest (see `movePane` in pane-tree).
  if (source.tab.id === target.tab.id) {
    const rootNode = movePaneInTree(
      source.tab.rootNode,
      sourcePaneId,
      targetPaneId,
      direction,
      position,
    );
    if (rootNode === null) return unchanged(state);
    return result(
      withTabRoot(state.layout, source.tab.id, rootNode),
      state.closedStack,
      hint,
    );
  }

  const moved = transplant(
    state.layout,
    { paneId: sourcePaneId },
    { into: "pane", paneId: targetPaneId, direction, position },
  );
  if (!moved) return unchanged(state);
  return result(moved.layout, state.closedStack, hint);
}

export function extractPaneToTab(
  state: LayoutState,
  command: CommandOf<"extract-pane-to-tab">,
): LayoutResult {
  const { paneId } = command;
  const source = findPanelWithPane(state.layout, paneId);
  if (!source) return unchanged(state);
  const destPanelId = command.targetPanelId ?? source.panel.id;
  if (!state.layout.panels[destPanelId]) return unchanged(state);

  // Already a tab of its own in the destination panel: nothing structural to
  // do, but the sender still learns which tab the pane is in.
  const sole = allPaneIds(source.tab.rootNode).length === 1;
  if (sole && source.panel.id === destPanelId) {
    return {
      ...unchanged(state),
      hint: { selectTab: { panelId: destPanelId, tabId: source.tab.id } },
    };
  }

  // A pane that was its tab's only one takes the tab — id and title — along;
  // anything else lands in a tab minted by the sender.
  const taken = take(state.layout, { paneId });
  if (!taken) return unchanged(state);
  const tab = taken.tabRemoved
    ? { id: source.tab.id, title: source.tab.title }
    : { id: command.newTabId, title: "Terminal" };
  const layout = graft(
    taken.layout,
    { into: "panel", panelId: destPanelId, tab },
    taken.subtree,
  );
  if (!layout) return unchanged(state);
  return result(
    layout,
    state.closedStack,
    landedHint(destPanelId, tab.id, paneId),
  );
}

export function closePane(
  state: LayoutState,
  command: CommandOf<"close-pane">,
): LayoutResult {
  const found = findPanelWithPane(state.layout, command.paneId);
  if (!found) return unchanged(state);
  // Last pane in the tab — the tab goes, and with it a tab-shaped undo entry.
  if (allPaneIds(found.tab.rootNode).length === 1) {
    return closeTab(state, found.tab.id);
  }

  const taken = take(state.layout, { paneId: command.paneId });
  if (!taken) return unchanged(state);
  const entry: ClosedPaneEntry = {
    kind: "pane",
    leaf: taken.subtree as PaneLeaf,
    tabId: found.tab.id,
    panelId: found.panel.id,
  };
  const remaining = findPanelWithTab(taken.layout, found.tab.id);
  return result(
    taken.layout,
    pushClosed(state.closedStack, entry),
    remaining
      ? {
          focusPane: {
            tabId: found.tab.id,
            paneId: firstPaneOf(remaining.tab.rootNode),
          },
        }
      : undefined,
    [command.paneId],
  );
}

export function reopenClosedPane(
  state: LayoutState,
  command: CommandOf<"reopen-closed-pane">,
): LayoutResult {
  const { layout, closedStack } = state;
  const entry = closedStack[0];
  if (!entry) return unchanged(state);
  const nextStack = closedStack.slice(1);

  const targetPanelId = layout.panels[entry.panelId]
    ? entry.panelId
    : (command.panelId ?? firstPanelId(layout));
  const targetPanel = targetPanelId ? layout.panels[targetPanelId] : undefined;
  if (!targetPanel) return unchanged(state);

  if (entry.kind === "tab") {
    const firstPane = firstPaneOf(entry.tab.rootNode);
    // The tab's panel went with it — rebuild the panel where it stood.
    const sc = entry.panelSplitContext;
    if (!layout.panels[entry.panelId] && sc && layout.panels[sc.siblingId]) {
      const restored: Panel = {
        id: entry.panelId,
        tabs: [entry.tab],
        pinnedTabIds: [],
      };
      return result(
        {
          panelTree: insertPanelSplit(
            layout.panelTree,
            sc.siblingId,
            sc.direction,
            entry.panelId,
            sc.position,
            sc.ratio,
          ),
          panels: { ...layout.panels, [entry.panelId]: restored },
        },
        nextStack,
        {
          selectTab: { panelId: entry.panelId, tabId: entry.tab.id },
          focusPane: { tabId: entry.tab.id, paneId: firstPane },
          activatePanel: entry.panelId,
        },
      );
    }
    return result(
      withPanel(layout, targetPanel.id, (p) => ({
        ...p,
        tabs: [...p.tabs, entry.tab],
      })),
      nextStack,
      {
        selectTab: { panelId: targetPanel.id, tabId: entry.tab.id },
        focusPane: { tabId: entry.tab.id, paneId: firstPane },
      },
    );
  }

  // A single pane goes back whole — same id, so the daemon session (still
  // alive during the grace period) is reattached rather than a fresh shell
  // spawned, and same leaf, so a browser pane keeps its url.
  const { leaf } = entry;
  const originalTab = targetPanel.tabs.find((t) => t.id === entry.tabId);
  if (originalTab) {
    const anchorPaneId =
      command.anchorPaneId && hasPaneId(originalTab.rootNode, command.anchorPaneId)
        ? command.anchorPaneId
        : firstPaneOf(originalTab.rootNode);
    const rootNode = insertSubtreeAt(
      originalTab.rootNode,
      anchorPaneId,
      "horizontal",
      leaf,
      "second",
    );
    return result(withTabRoot(layout, originalTab.id, rootNode), nextStack, {
      selectTab: { panelId: targetPanel.id, tabId: originalTab.id },
      focusPane: { tabId: originalTab.id, paneId: leaf.paneId },
    });
  }

  const restoredTab: Tab = {
    id: command.newTabId,
    title: entry.title ?? "Terminal",
    rootNode: leaf,
  };
  return result(
    withPanel(layout, targetPanel.id, (p) => ({
      ...p,
      tabs: [...p.tabs, restoredTab],
    })),
    nextStack,
    {
      selectTab: { panelId: targetPanel.id, tabId: restoredTab.id },
      focusPane: { tabId: restoredTab.id, paneId: leaf.paneId },
    },
  );
}

export function setPaneContentType(
  state: LayoutState,
  command: CommandOf<"set-pane-content-type">,
): LayoutResult {
  const found = findPanelWithPane(state.layout, command.paneId);
  if (!found) return unchanged(state);
  const { tab } = found;
  // "terminal" is the implicit default and is never written to the tree.
  const treeType =
    command.contentType === "terminal" ? undefined : command.contentType;
  let rootNode = updateLeafContentType(tab.rootNode, command.paneId, treeType);
  if (command.url !== undefined) {
    rootNode = updateLeafUrl(rootNode, command.paneId, command.url);
  }
  if (rootNode === tab.rootNode) return unchanged(state);
  return result(withTabRoot(state.layout, tab.id, rootNode), state.closedStack);
}

export function updateSplitRatio(
  state: LayoutState,
  command: CommandOf<"update-split-ratio">,
): LayoutResult {
  const found = findPanelWithPane(state.layout, command.firstPaneId);
  if (!found) return unchanged(state);
  const { tab } = found;
  const rootNode = updateRatio(tab.rootNode, command.firstPaneId, command.ratio);
  if (rootNode === tab.rootNode) return unchanged(state);
  return result(withTabRoot(state.layout, tab.id, rootNode), state.closedStack);
}
