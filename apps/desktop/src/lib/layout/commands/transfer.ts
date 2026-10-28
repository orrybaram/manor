/**
 * Moving a tab, or one pane, from one workspace to another.
 *
 * Not a `LayoutCommand`: the reducer works on one workspace at a time, and a
 * move needs two. `LayoutStore.moveToWorkspace` runs these two halves, one on
 * each workspace, inside both workspaces' command queues, and commits both
 * results together — so the pane is never in neither workspace, nor in both.
 *
 * Unlike a close, sending kills nothing and pushes nothing onto the reopen
 * stack: the panes carry on, in the other workspace. Ids travel unchanged, so
 * a pane's session, queued command and agent stay its own.
 */

import { allPaneIds } from "../pane-tree";
import type { Tab } from "../workspace-layout";
import { findPanelWithPane, findPanelWithTab } from "../workspace-layout";
import {
  firstPaneOf,
  firstPanelId,
  landedHint,
  result,
  take,
  type TakeTarget,
  withPanel,
} from "./graft";
import type { LayoutResult, LayoutState } from "./types";

/** What one workspace hands another: a whole tab, pinned or not. */
export interface SentTab {
  tab: Tab;
  pinned: boolean;
  /** The pane the receiver should focus: the moved pane, or the tab's first. */
  focusPaneId: string;
}

/**
 * Take a tab, or one pane, out of a workspace without ending anything.
 *
 * A tab goes whole: its split tree, title, pane ids and pinned state. A pane
 * that was its tab's only one takes the tab with it, as `extract-pane-to-tab`
 * does; any other pane leaves its tab behind and travels in a new one, named
 * `newTabId` by the sender. The source's emptied tab and panel follow the one
 * empty-panel rule (`take`): the last panel stays, empty.
 *
 * Null when the workspace does not hold the target.
 */
export function sendTab(
  state: LayoutState,
  target: TakeTarget,
  newTabId: string,
): { result: LayoutResult; sent: SentTab } | null {
  const found =
    "tabId" in target
      ? findPanelWithTab(state.layout, target.tabId)
      : findPanelWithPane(state.layout, target.paneId);
  if (!found) return null;
  const sole = allPaneIds(found.tab.rootNode).length === 1;
  const whole = "tabId" in target || sole;
  const taken = take(state.layout, whole ? { tabId: found.tab.id } : target);
  if (!taken) return null;

  const tab: Tab = whole
    ? found.tab
    : { id: newTabId, title: "Terminal", rootNode: taken.subtree };
  const pinned = whole && found.panel.pinnedTabIds.includes(found.tab.id);
  const focusPaneId =
    "paneId" in target ? target.paneId : firstPaneOf(found.tab.rootNode);
  return {
    // The reopen stack is the source's own, untouched: a move is not a close.
    result: result(taken.layout, state.closedStack),
    sent: { tab, pinned, focusPaneId },
  };
}

/**
 * Add a tab another workspace sent as a new tab of `panelId` (the first
 * panel when it names none, or one the layout lacks). A pinned tab joins the
 * end of the panel's pinned block. The hint selects it and focuses the pane
 * that moved, for the renderer that asked.
 *
 * Null when the layout has no panel, or already holds the tab.
 */
export function receiveTab(
  state: LayoutState,
  sent: SentTab,
  panelId?: string,
): LayoutResult | null {
  const { layout } = state;
  const destPanelId =
    panelId !== undefined && layout.panels[panelId]
      ? panelId
      : firstPanelId(layout);
  if (!destPanelId || !layout.panels[destPanelId]) return null;
  if (findPanelWithTab(layout, sent.tab.id)) return null;

  const next = withPanel(layout, destPanelId, (panel) => {
    if (!sent.pinned) return { ...panel, tabs: [...panel.tabs, sent.tab] };
    const at = panel.pinnedTabIds.length;
    return {
      ...panel,
      tabs: [...panel.tabs.slice(0, at), sent.tab, ...panel.tabs.slice(at)],
      pinnedTabIds: [...panel.pinnedTabIds, sent.tab.id],
    };
  });
  return result(
    next,
    state.closedStack,
    landedHint(destPanelId, sent.tab.id, sent.focusPaneId),
  );
}
