/** Tab commands: open, close, duplicate, reorder, pin, and tab-sized moves. */

import { allPaneIds } from "../pane-tree";
import { findPanelSplitContext } from "../panel-tree";
import type { LayoutHint } from "../viewport";
import {
  type Tab,
  findPanelWithPane,
  findPanelWithTab,
} from "../workspace-layout";
import {
  firstPaneOf,
  firstPanelId,
  landedHint,
  pushClosed,
  result,
  take,
  transplant,
  unchanged,
  withPanel,
} from "./graft";
import type {
  ClosedTabEntry,
  CommandOf,
  LayoutResult,
  LayoutState,
} from "./types";

export function newTab(
  state: LayoutState,
  command: CommandOf<"new-tab">,
): LayoutResult {
  const { layout, closedStack } = state;
  const panelId = command.panelId ?? firstPanelId(layout);
  if (!panelId || !layout.panels[panelId]) return unchanged(state);
  const select = command.select ?? true;
  return result(
    withPanel(layout, panelId, (p) => ({ ...p, tabs: [...p.tabs, command.tab] })),
    closedStack,
    select
      ? {
          selectTab: { panelId, tabId: command.tab.id },
          focusPane: {
            tabId: command.tab.id,
            paneId: firstPaneOf(command.tab.rootNode),
          },
        }
      : undefined,
  );
}

export function closeTab(state: LayoutState, tabId: string): LayoutResult {
  const found = findPanelWithTab(state.layout, tabId);
  const taken = take(state.layout, { tabId });
  if (!found || !taken) return unchanged(state);
  const { panel, tab } = found;

  const entry: ClosedTabEntry = {
    kind: "tab",
    tab,
    panelId: panel.id,
    ...(taken.panelRemoved && {
      panelSplitContext:
        findPanelSplitContext(state.layout.panelTree, panel.id) ?? undefined,
    }),
  };

  let hint: LayoutHint | undefined;
  if (taken.panelRemoved) {
    const next = firstPanelId(taken.layout);
    hint = next !== undefined ? { activatePanel: next } : undefined;
  } else {
    // The selection hands over to the tab that slid into the closed one's
    // place, or to the new last tab.
    const idx = panel.tabs.findIndex((t) => t.id === tabId);
    const rest = panel.tabs.filter((t) => t.id !== tabId);
    const neighbour = rest[Math.min(idx, rest.length - 1)];
    hint = neighbour
      ? { selectTab: { panelId: panel.id, tabId: neighbour.id } }
      : undefined;
  }

  return result(
    taken.layout,
    pushClosed(state.closedStack, entry),
    hint,
    allPaneIds(tab.rootNode),
  );
}

export function closeManyTabs(
  state: LayoutState,
  command: CommandOf<"close-other-tabs" | "close-tabs-to-right">,
): LayoutResult {
  const found = findPanelWithTab(state.layout, command.tabId);
  if (!found) return unchanged(state);
  const { panel } = found;
  const pinned = new Set(panel.pinnedTabIds);

  const idx = panel.tabs.findIndex((t) => t.id === command.tabId);
  const candidates =
    command.type === "close-other-tabs"
      ? panel.tabs.filter((t) => t.id !== command.tabId)
      : panel.tabs.slice(idx + 1);
  const toClose = candidates.map((t) => t.id).filter((id) => !pinned.has(id));
  if (toClose.length === 0) return unchanged(state);

  let acc: LayoutState = state;
  const killPanes: string[] = [];
  for (const id of toClose) {
    const step = closeTab(acc, id);
    acc = step;
    killPanes.push(...step.killPanes);
  }
  // The tab the user kept is the one to look at, whatever the last close of
  // the chain happened to hand its neighbour.
  return result(
    acc.layout,
    acc.closedStack,
    { selectTab: { panelId: panel.id, tabId: command.tabId } },
    killPanes,
  );
}

export function duplicateTab(
  state: LayoutState,
  command: CommandOf<"duplicate-tab">,
): LayoutResult {
  const found = findPanelWithTab(state.layout, command.tabId);
  if (!found) return unchanged(state);
  return result(
    withPanel(state.layout, found.panel.id, (p) => ({
      ...p,
      tabs: [...p.tabs, command.newTab],
    })),
    state.closedStack,
    {
      selectTab: { panelId: found.panel.id, tabId: command.newTab.id },
      focusPane: {
        tabId: command.newTab.id,
        paneId: firstPaneOf(command.newTab.rootNode),
      },
    },
  );
}

export function reorderTabs(
  state: LayoutState,
  command: CommandOf<"reorder-tabs">,
): LayoutResult {
  const panel = state.layout.panels[command.panelId];
  if (!panel) return unchanged(state);
  const lookup = new Map(panel.tabs.map((t) => [t.id, t]));
  const reordered = command.tabIds
    .map((id) => lookup.get(id))
    .filter((t): t is Tab => t !== undefined);
  // A partial order would silently drop tabs — refuse it.
  if (reordered.length !== panel.tabs.length) return unchanged(state);
  return result(
    withPanel(state.layout, panel.id, (p) => ({ ...p, tabs: reordered })),
    state.closedStack,
  );
}

export function togglePinTab(
  state: LayoutState,
  command: CommandOf<"toggle-pin-tab">,
): LayoutResult {
  const found = findPanelWithTab(state.layout, command.tabId);
  if (!found) return unchanged(state);
  const { panel, tab } = found;
  const pinned = panel.pinnedTabIds;
  const isPinned = pinned.includes(command.tabId);

  // Pinned tabs sit at the front, in pin order. Pinning moves the tab to the
  // end of that block; unpinning parks it just after it.
  const newPinned = isPinned
    ? pinned.filter((id) => id !== command.tabId)
    : [...pinned, command.tabId];
  const insertIdx = isPinned ? newPinned.length : pinned.length;
  const others = panel.tabs.filter((t) => t.id !== command.tabId);
  const tabs = [...others.slice(0, insertIdx), tab, ...others.slice(insertIdx)];

  return result(
    withPanel(state.layout, panel.id, (p) => ({
      ...p,
      tabs,
      pinnedTabIds: newPinned,
    })),
    state.closedStack,
  );
}

/** A whole tab, grafted beside one pane of another tab. */
export function moveTabToPane(
  state: LayoutState,
  command: CommandOf<"move-tab-to-pane">,
): LayoutResult {
  const target = findPanelWithPane(state.layout, command.targetPaneId);
  if (!target || target.tab.id === command.tabId) return unchanged(state);
  const moved = transplant(
    state.layout,
    { tabId: command.tabId },
    {
      into: "pane",
      paneId: command.targetPaneId,
      direction: command.direction,
      position: command.position,
    },
  );
  if (!moved) return unchanged(state);
  return result(
    moved.layout,
    state.closedStack,
    landedHint(
      target.panel.id,
      target.tab.id,
      firstPaneOf(moved.taken.subtree),
    ),
  );
}

/**
 * A whole tab, grafted as one side of a new split of another tab's tree. No
 * ids are minted, which is why this is not `move-tab-to-pane`: that splits
 * beside one pane of the target, this beside all of it.
 */
export function mergeTabIntoTab(
  state: LayoutState,
  command: CommandOf<"merge-tab-into-tab">,
): LayoutResult {
  const { sourceTabId, targetTabId } = command;
  const target = findPanelWithTab(state.layout, targetTabId);
  if (sourceTabId === targetTabId || !target) return unchanged(state);
  const moved = transplant(
    state.layout,
    { tabId: sourceTabId },
    {
      into: "tab",
      tabId: targetTabId,
      direction: "horizontal",
      position: command.position ?? "second",
    },
  );
  if (!moved) return unchanged(state);
  return result(
    moved.layout,
    state.closedStack,
    landedHint(target.panel.id, targetTabId, firstPaneOf(moved.taken.subtree)),
  );
}
