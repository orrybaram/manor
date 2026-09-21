/**
 * The layout command reducer (ADR-179 D1/D2).
 *
 * Every structural change to a workspace — split, close, move, pin, reorder —
 * is a `LayoutCommand`. `applyLayoutCommand` is the one place that turns a
 * command into a new `WorkspaceLayout`. It is pure: no store, no
 * `window.electronAPI`, no side maps, and no `crypto.randomUUID`. Anything the
 * host must *do* after a structural change comes back in `LayoutEffects`.
 *
 * Two rules make it usable from a server that has no idea what any window is
 * looking at:
 *
 * 1. **Ids come in the command.** The sender mints every new pane/tab/panel id
 *    before sending, so it can focus the new pane when the broadcast lands.
 * 2. **"Current" is resolved by the sender.** "Split the focused pane" is
 *    `{ type: "split-pane", paneId }`. The reducer cannot read a selection
 *    and does not have one: selection is viewport, per renderer (D3). The
 *    handful of optional command fields documented as "viewport default"
 *    exist only so a command is still applicable when a sender omits them;
 *    the desktop store always passes them.
 *
 * What a command *implies* about the sender's selection — a new tab is
 * selected, a closed tab hands over to a neighbour, a split focuses the pane
 * it made — comes back as a {@link LayoutHint} in `effects`. Only the
 * renderer that sent the command applies it; every other one keeps looking
 * where it was looking.
 *
 * A command naming an id that is not in the tree is a no-op, not a throw: a
 * stale command from a slow renderer is normal.
 */

import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  insertSplitAt,
  insertSubtreeAt,
  movePane,
  removePane,
  updateLeafContentType,
  updateLeafUrl,
  updateRatio,
} from "./pane-tree";
import {
  type PanelNode,
  allPanelIds,
  findPanelSplitContext,
  insertPanelSplit,
  nextPanelId,
  removePanel as removePanelFromTree,
  updatePanelRatio,
} from "./panel-tree";
import type { LayoutHint } from "./viewport";
import {
  type PaneContentType,
  type Panel,
  type Tab,
  type WorkspaceLayout,
  createSinglePanelLayout,
  findPanelWithPane,
  findPanelWithTab,
} from "./workspace-layout";

/** How many closed panes/tabs a workspace can restore, newest first. */
export const MAX_CLOSED_STACK = 10;

/**
 * What a closed pane needs to come back. Content type, url, cwd and title are
 * per-pane side state the reducer does not own: the host hands them in
 * alongside the closing command and the reopen hands them back.
 *
 * It is not part of the command, because a *sender* has no business being
 * right about them: `LayoutStore.apply` builds the map from the pane tree
 * (contentType, url) and from its own server-derived `paneSessions` (cwd,
 * title) and passes it as `applyLayoutCommand`'s third argument (ADR-179 D3).
 */
export interface PaneMetadata {
  contentType?: PaneContentType;
  url?: string;
  cwd?: string;
  title?: string;
}

/** Per-pane metadata for a closing command, keyed by paneId. */
export type PaneMetadataMap = Record<string, PaneMetadata>;

/** Where a removed panel sat, so reopening its last tab can rebuild it. */
export interface PanelSplitContext {
  siblingId: string;
  direction: SplitDirection;
  ratio: number;
  position: "first" | "second";
}

export interface ClosedPaneEntry extends PaneMetadata {
  kind: "pane";
  paneId: string;
  tabId: string;
  panelId: string;
}

export interface ClosedTabEntry {
  kind: "tab";
  tab: Tab;
  panelId: string;
  paneMetadata: PaneMetadataMap;
  /** Set when closing this tab also removed its panel. */
  panelSplitContext?: PanelSplitContext;
}

/** One entry of the reopen stack. */
export type ClosedPane = ClosedPaneEntry | ClosedTabEntry;

export type LayoutCommand =
  | { type: "new-tab"; tab: Tab; panelId?: string; select?: boolean }
  | { type: "close-tab"; tabId: string }
  | { type: "duplicate-tab"; tabId: string; newTab: Tab }
  | { type: "close-other-tabs"; tabId: string }
  | { type: "close-tabs-to-right"; tabId: string }
  | { type: "reorder-tabs"; panelId: string; tabIds: string[] }
  | { type: "toggle-pin-tab"; tabId: string }
  | {
      type: "split-pane";
      paneId: string;
      direction: SplitDirection;
      newPaneId: string;
      contentType?: PaneContentType;
      url?: string;
    }
  | {
      type: "split-pane-at";
      paneId: string;
      direction: SplitDirection;
      position: "first" | "second";
      newPaneId: string;
      contentType?: PaneContentType;
      url?: string;
    }
  | {
      type: "move-pane";
      sourcePaneId: string;
      targetPaneId: string;
      direction: SplitDirection;
      position: "first" | "second";
      /** Used when the move empties the source panel and it is the last one. */
      fallbackTab?: Tab;
    }
  | {
      type: "move-tab-to-pane";
      tabId: string;
      targetPaneId: string;
      direction: SplitDirection;
      position: "first" | "second";
      /** Used when the move empties the source panel and it is the last one. */
      fallbackTab?: Tab;
    }
  | {
      type: "extract-pane-to-tab";
      paneId: string;
      targetPanelId?: string;
      newTabId: string;
      /** Used when the move empties the source panel and it is the last one. */
      fallbackTab?: Tab;
    }
  | { type: "close-pane"; paneId: string }
  | {
      type: "reopen-closed-pane";
      /** Tab to restore a pane into when its original tab is gone. */
      newTabId: string;
      /** Panel to restore into when the original panel is gone.
       *  Viewport default: the active panel. */
      panelId?: string;
      /** Pane the restored pane splits off.
       *  Viewport default: the target tab's focused pane. */
      anchorPaneId?: string;
    }
  | {
      type: "set-pane-content-type";
      paneId: string;
      contentType: PaneContentType;
      url?: string;
    }
  | {
      type: "split-panel";
      panelId: string;
      direction: SplitDirection;
      newPanelId: string;
      /** Tab to move into the new panel.
       *  Viewport default: the panel's selected tab. */
      tabId?: string;
      /** Used when moving that tab out leaves the source panel empty. */
      fallbackTab?: Tab;
    }
  | {
      type: "close-panel";
      panelId: string;
      /** Panel id for the empty layout left behind when this was the last
       *  panel. Defaults to reusing the closed panel's id. */
      fallbackPanelId?: string;
    }
  | {
      /**
       * Drag a tab onto another tab's pane tree: the source tab stops being a
       * tab and becomes a split of the target's. No ids are minted — the
       * source subtree keeps the panes it already has.
       */
      type: "merge-tab-into-tab";
      sourceTabId: string;
      targetTabId: string;
      /** Which side of the new split the source subtree lands on.
       *  Defaults to "second" — dropped tab goes right/below. */
      position?: "first" | "second";
      /** Used when the merge empties the source panel and it is the last one. */
      fallbackTab?: Tab;
    }
  | { type: "update-panel-ratio"; firstPanelId: string; ratio: number }
  | { type: "move-tab-to-panel"; tabId: string; targetPanelId: string }
  | {
      type: "split-panel-with-tab";
      tabId: string;
      targetPanelId: string;
      direction: SplitDirection;
      newPanelId: string;
      /** Used when moving the tab out leaves the source panel empty. */
      fallbackTab?: Tab;
    }
  | {
      /**
       * A new panel beside `sourcePanelId`, holding a brand-new tab — the
       * source panel keeps every tab it had.
       *
       * Deliberately not `new-tab` + `split-panel`: `split-panel` *moves* the
       * source panel's selected tab into the new panel, which is not what
       * "open the diff beside this" means.
       */
      type: "split-panel-with-new-tab";
      tab: Tab;
      direction: SplitDirection;
      newPanelId: string;
      sourcePanelId: string;
    }
  | { type: "update-split-ratio"; firstPaneId: string; ratio: number };

export interface LayoutEffects extends LayoutHint {
  /** Terminal panes that left the tree; the host ends their sessions. */
  killPanes: string[];
  /** Panes that left the tree but must stay alive (moved, extracted). */
  releasedPanes: string[];
}

/** The reducer's whole state for one workspace. */
export interface LayoutState {
  layout: WorkspaceLayout;
  closedStack: ClosedPane[];
}

export interface LayoutResult extends LayoutState {
  effects: LayoutEffects;
}

const NO_EFFECTS: LayoutEffects = { killPanes: [], releasedPanes: [] };

/** Nothing happened — same references out, so callers can skip a re-render. */
function unchanged(state: LayoutState): LayoutResult {
  return {
    layout: state.layout,
    closedStack: state.closedStack,
    effects: NO_EFFECTS,
  };
}

function result(
  layout: WorkspaceLayout,
  closedStack: ClosedPane[],
  effects?: Partial<LayoutEffects>,
): LayoutResult {
  return {
    layout,
    closedStack,
    effects: {
      ...effects,
      killPanes: effects?.killPanes ?? [],
      releasedPanes: effects?.releasedPanes ?? [],
    },
  };
}

/** Later wins for the hint; the pane lists accumulate. */
function mergeEffects(a: LayoutEffects, b: LayoutEffects): LayoutEffects {
  return {
    ...a,
    ...b,
    killPanes: [...a.killPanes, ...b.killPanes],
    releasedPanes: [...a.releasedPanes, ...b.releasedPanes],
  };
}

/**
 * The panel a command lands in when it names none.
 *
 * "The active panel" is the sender's viewport and never reaches here, so the
 * reducer falls back to the leftmost panel in the tree — which is the right
 * answer for the one case that matters, a workspace with a single panel.
 */
function firstPanelId(layout: WorkspaceLayout): string | undefined {
  const inTree = allPanelIds(layout.panelTree).filter(
    (id) => layout.panels[id] !== undefined,
  );
  return inTree[0] ?? Object.keys(layout.panels)[0];
}

/** Replace one panel, leaving the rest of the layout by reference. */
function withPanel(
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

/** Replace one tab of one panel, leaving the rest by reference. */
function withTab(
  layout: WorkspaceLayout,
  panelId: string,
  tabId: string,
  updater: (tab: Tab) => Tab,
): WorkspaceLayout {
  return withPanel(layout, panelId, (panel) => ({
    ...panel,
    tabs: panel.tabs.map((t) => (t.id === tabId ? updater(t) : t)),
  }));
}

/** Every pane in every tab of a panel. */
function panelPaneIds(panel: Panel): string[] {
  return panel.tabs.flatMap((tab) => allPaneIds(tab.rootNode));
}

function pushClosed(stack: ClosedPane[], entry: ClosedPane): ClosedPane[] {
  return [entry, ...stack].slice(0, MAX_CLOSED_STACK);
}

/**
 * Drop a tab from a panel the way every cross-panel move does: collapse the
 * panel when it empties and another remains, otherwise seed it with
 * `fallbackTab` so no panel is ever left blank.
 */
function detachTabFromPanel(
  panels: Record<string, Panel>,
  panelTree: PanelNode,
  sourcePanel: Panel,
  tabId: string,
  fallbackTab: Tab | undefined,
): { panels: Record<string, Panel>; panelTree: PanelNode } {
  const nextPanels = { ...panels };
  let nextTree = panelTree;
  const remainingTabs = sourcePanel.tabs.filter((t) => t.id !== tabId);

  if (remainingTabs.length === 0 && Object.keys(nextPanels).length > 1) {
    const pruned = removePanelFromTree(nextTree, sourcePanel.id);
    if (pruned) nextTree = pruned;
    delete nextPanels[sourcePanel.id];
  } else if (remainingTabs.length === 0) {
    nextPanels[sourcePanel.id] = {
      ...sourcePanel,
      tabs: fallbackTab ? [fallbackTab] : [],
      pinnedTabIds: [],
    };
  } else {
    nextPanels[sourcePanel.id] = {
      ...sourcePanel,
      tabs: remainingTabs,
      pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter(
        (id) => id !== tabId,
      ),
    };
  }

  return { panels: nextPanels, panelTree: nextTree };
}

// ───────────────────────────── the reducer ──────────────────────────────

export function applyLayoutCommand(
  state: LayoutState,
  command: LayoutCommand,
  /**
   * What the host knows about every pane, for the reopen stack (see
   * `PaneMetadata`). Only the closing commands read it; a host that keeps no
   * such state may omit it and lose nothing but a restored cwd.
   */
  paneMetadata?: PaneMetadataMap,
): LayoutResult {
  const { layout, closedStack } = state;

  switch (command.type) {
    case "new-tab":
      return newTab(state, command);
    case "close-tab":
      return closeTab(state, command.tabId, paneMetadata);
    case "duplicate-tab":
      return duplicateTab(state, command);
    case "close-other-tabs":
    case "close-tabs-to-right":
      return closeManyTabs(state, command, paneMetadata);
    case "reorder-tabs":
      return reorderTabs(state, command);
    case "toggle-pin-tab":
      return togglePinTab(state, command);
    case "split-pane":
      return splitPaneAt(state, {
        type: "split-pane-at",
        paneId: command.paneId,
        direction: command.direction,
        position: "second",
        newPaneId: command.newPaneId,
        contentType: command.contentType,
        url: command.url,
      });
    case "split-pane-at":
      return splitPaneAt(state, command);
    case "move-pane":
      return movePaneToTarget(state, command);
    case "move-tab-to-pane":
      return moveTabToPane(state, command);
    case "extract-pane-to-tab":
      return extractPaneToTab(state, command);
    case "close-pane":
      return closePane(state, command, paneMetadata);
    case "reopen-closed-pane":
      return reopenClosedPane(state, command);
    case "set-pane-content-type":
      return setPaneContentType(state, command);
    case "split-panel":
      return splitPanel(state, command);
    case "close-panel":
      return closePanel(state, command);
    case "update-panel-ratio": {
      const panelTree = updatePanelRatio(
        layout.panelTree,
        command.firstPanelId,
        command.ratio,
      );
      if (panelTree === layout.panelTree) return unchanged(state);
      return result({ ...layout, panelTree }, closedStack);
    }
    case "move-tab-to-panel":
      return moveTabToPanel(state, command);
    case "split-panel-with-tab":
      return splitPanelWithTab(state, command);
    case "merge-tab-into-tab":
      return mergeTabIntoTab(state, command);
    case "split-panel-with-new-tab":
      return splitPanelWithNewTab(state, command);
    case "update-split-ratio":
      return updateSplitRatio(state, command);
  }
}

// ───────────────────────────────── tabs ──────────────────────────────────

function newTab(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "new-tab" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const panelId = command.panelId ?? firstPanelId(layout);
  const panel = panelId ? layout.panels[panelId] : undefined;
  if (!panel || !panelId) return unchanged(state);
  const select = command.select ?? true;
  return result(
    withPanel(layout, panelId, (p) => ({
      ...p,
      tabs: [...p.tabs, command.tab],
    })),
    closedStack,
    select
      ? {
          selectTab: { panelId, tabId: command.tab.id },
          focusPane: {
            tabId: command.tab.id,
            paneId: allPaneIds(command.tab.rootNode)[0],
          },
        }
      : undefined,
  );
}

function closeTab(
  state: LayoutState,
  tabId: string,
  paneMetadata: PaneMetadataMap | undefined,
): LayoutResult {
  const { layout, closedStack } = state;
  const found = findPanelWithTab(layout, tabId);
  if (!found) return unchanged(state);
  const { panel, tab: closingTab } = found;

  const deadPaneIds = allPaneIds(closingTab.rootNode);

  const idx = panel.tabs.findIndex((t) => t.id === tabId);
  const newTabs = panel.tabs.filter((t) => t.id !== tabId);
  const neighbour =
    newTabs.length === 0
      ? undefined
      : newTabs[Math.min(idx, newTabs.length - 1)].id;

  const snapshotMetadata: PaneMetadataMap = {};
  for (const pid of deadPaneIds) snapshotMetadata[pid] = paneMetadata?.[pid] ?? {};

  // The panel goes with its last tab, but only while another panel remains.
  const willRemovePanel =
    newTabs.length === 0 && Object.keys(layout.panels).length > 1;

  const entry: ClosedTabEntry = {
    kind: "tab",
    tab: closingTab,
    panelId: panel.id,
    paneMetadata: snapshotMetadata,
    ...(willRemovePanel && {
      panelSplitContext:
        findPanelSplitContext(layout.panelTree, panel.id) ?? undefined,
    }),
  };
  const nextStack = pushClosed(closedStack, entry);
  const effects: Partial<LayoutEffects> = {
    killPanes: deadPaneIds,
    ...(neighbour !== undefined && {
      selectTab: { panelId: panel.id, tabId: neighbour },
    }),
  };

  if (willRemovePanel) {
    const panelTree = removePanelFromTree(layout.panelTree, panel.id);
    const { [panel.id]: _removed, ...remainingPanels } = layout.panels;
    const next = {
      ...layout,
      panelTree: panelTree ?? layout.panelTree,
      panels: remainingPanels,
    };
    return result(next, nextStack, {
      killPanes: deadPaneIds,
      ...(firstPanelId(next) !== undefined && {
        activatePanel: firstPanelId(next),
      }),
    });
  }

  return result(
    withPanel(layout, panel.id, (p) => ({
      ...p,
      tabs: newTabs,
      pinnedTabIds: (p.pinnedTabIds ?? []).filter((id) => id !== tabId),
    })),
    nextStack,
    effects,
  );
}

function closeManyTabs(
  state: LayoutState,
  command: Extract<
    LayoutCommand,
    { type: "close-other-tabs" | "close-tabs-to-right" }
  >,
  paneMetadata: PaneMetadataMap | undefined,
): LayoutResult {
  const found = findPanelWithTab(state.layout, command.tabId);
  if (!found) return unchanged(state);
  const { panel } = found;
  const pinned = new Set(panel.pinnedTabIds ?? []);

  let candidates: Tab[];
  if (command.type === "close-other-tabs") {
    candidates = panel.tabs.filter((t) => t.id !== command.tabId);
  } else {
    const idx = panel.tabs.findIndex((t) => t.id === command.tabId);
    if (idx === -1) return unchanged(state);
    candidates = panel.tabs.slice(idx + 1);
  }
  const toClose = candidates
    .map((t) => t.id)
    .filter((id) => !pinned.has(id));
  if (toClose.length === 0) return unchanged(state);

  let acc: LayoutResult = { ...state, effects: NO_EFFECTS };
  for (const id of toClose) {
    const step = closeTab(acc, id, paneMetadata);
    acc = {
      layout: step.layout,
      closedStack: step.closedStack,
      effects: mergeEffects(acc.effects, step.effects),
    };
  }
  // The tab the user kept is the one to look at, whatever the last close of
  // the chain happened to hand its neighbour.
  return {
    ...acc,
    effects: {
      ...acc.effects,
      selectTab: { panelId: panel.id, tabId: command.tabId },
    },
  };
}

function duplicateTab(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "duplicate-tab" }>,
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
        paneId: allPaneIds(command.newTab.rootNode)[0],
      },
    },
  );
}

function reorderTabs(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "reorder-tabs" }>,
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

function togglePinTab(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "toggle-pin-tab" }>,
): LayoutResult {
  const found = findPanelWithTab(state.layout, command.tabId);
  if (!found) return unchanged(state);
  const { panel, tab } = found;
  const pinned = panel.pinnedTabIds ?? [];
  const isPinned = pinned.includes(command.tabId);

  // Pinned tabs sit at the front, in pin order. Pinning moves the tab to the
  // end of that block; unpinning parks it just after it.
  const newPinned = isPinned
    ? pinned.filter((id) => id !== command.tabId)
    : [...pinned, command.tabId];
  const insertIdx = isPinned ? newPinned.length : pinned.length;
  const others = panel.tabs.filter((t) => t.id !== command.tabId);
  const newTabs = [
    ...others.slice(0, insertIdx),
    tab,
    ...others.slice(insertIdx),
  ];

  return result(
    withPanel(state.layout, panel.id, (p) => ({
      ...p,
      tabs: newTabs,
      pinnedTabIds: newPinned,
    })),
    state.closedStack,
  );
}

// ───────────────────────────────── panes ─────────────────────────────────

function splitPaneAt(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "split-pane-at" }>,
): LayoutResult {
  const found = findPanelWithPane(state.layout, command.paneId);
  if (!found) return unchanged(state);
  const { panel, tab } = found;
  const rootNode = insertSplitAt(
    tab.rootNode,
    command.paneId,
    command.direction,
    command.newPaneId,
    command.position,
    command.contentType,
    command.url,
  );
  return result(
    withTab(state.layout, panel.id, tab.id, (t) => ({ ...t, rootNode })),
    state.closedStack,
    { focusPane: { tabId: tab.id, paneId: command.newPaneId } },
  );
}

function movePaneToTarget(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "move-pane" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const { sourcePaneId, targetPaneId, direction, position } = command;
  const src = findPanelWithPane(layout, sourcePaneId);
  const tgt = findPanelWithPane(layout, targetPaneId);
  if (!src || !tgt) return unchanged(state);
  const { panel: sourcePanel, tab: sourceTab } = src;
  const { panel: targetPanel, tab: targetTab } = tgt;
  const effects: Partial<LayoutEffects> = {
    releasedPanes: [sourcePaneId],
    focusPane: { tabId: targetTab.id, paneId: sourcePaneId },
  };

  // Same tab — a reshuffle inside one tree.
  if (sourcePanel.id === targetPanel.id && sourceTab.id === targetTab.id) {
    const rootNode = movePane(
      sourceTab.rootNode,
      sourcePaneId,
      targetPaneId,
      direction,
      position,
    );
    if (rootNode === null) return unchanged(state);
    return result(
      withTab(layout, sourcePanel.id, sourceTab.id, (t) => ({ ...t, rootNode })),
      closedStack,
      effects,
    );
  }

  const sourceRootAfterRemove = removePane(sourceTab.rootNode, sourcePaneId);
  const newTargetRoot = insertSplitAt(
    targetTab.rootNode,
    targetPaneId,
    direction,
    sourcePaneId,
    position,
  );

  // Same panel, cross-tab.
  if (sourcePanel.id === targetPanel.id) {
    let newTabs: Tab[];
    if (sourceRootAfterRemove === null) {
      newTabs = sourcePanel.tabs
        .filter((t) => t.id !== sourceTab.id)
        .map((t) =>
          t.id === targetTab.id ? { ...t, rootNode: newTargetRoot } : t,
        );
    } else {
      newTabs = sourcePanel.tabs.map((t) => {
        if (t.id === sourceTab.id) {
          return { ...t, rootNode: sourceRootAfterRemove };
        }
        if (t.id === targetTab.id) {
          return { ...t, rootNode: newTargetRoot };
        }
        return t;
      });
    }

    return result(
      withPanel(layout, sourcePanel.id, (p) => ({
        ...p,
        tabs: newTabs,
        pinnedTabIds:
          sourceRootAfterRemove === null
            ? (p.pinnedTabIds ?? []).filter((id) => id !== sourceTab.id)
            : p.pinnedTabIds,
      })),
      closedStack,
      {
        ...effects,
        selectTab: { panelId: sourcePanel.id, tabId: targetTab.id },
      },
    );
  }

  // Cross-panel.
  let panels: Record<string, Panel> = {
    ...layout.panels,
    [targetPanel.id]: {
      ...targetPanel,
      tabs: targetPanel.tabs.map((t) =>
        t.id === targetTab.id ? { ...t, rootNode: newTargetRoot } : t,
      ),
    },
  };
  let panelTree = layout.panelTree;

  if (sourceRootAfterRemove === null) {
    const detached = detachTabFromPanel(
      panels,
      panelTree,
      sourcePanel,
      sourceTab.id,
      command.fallbackTab,
    );
    panels = detached.panels;
    panelTree = detached.panelTree;
  } else {
    panels[sourcePanel.id] = {
      ...sourcePanel,
      tabs: sourcePanel.tabs.map((t) =>
        t.id === sourceTab.id ? { ...t, rootNode: sourceRootAfterRemove } : t,
      ),
    };
  }

  return result({ ...layout, panelTree, panels }, closedStack, {
    ...effects,
    selectTab: { panelId: targetPanel.id, tabId: targetTab.id },
    activatePanel: targetPanel.id,
  });
}

function moveTabToPane(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "move-tab-to-pane" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const { tabId, targetPaneId, direction, position } = command;
  const src = findPanelWithTab(layout, tabId);
  const tgt = findPanelWithPane(layout, targetPaneId);
  if (!src || !tgt) return unchanged(state);
  const { panel: sourcePanel, tab: sourceTab } = src;
  const { panel: targetPanel, tab: targetTab } = tgt;
  if (sourceTab.id === targetTab.id) return unchanged(state);

  // A one-pane tab grafts as a leaf; anything bigger goes in as a subtree.
  let newTargetRoot: PaneNode;
  let focusPaneId: string;
  if (sourceTab.rootNode.type === "leaf") {
    focusPaneId = sourceTab.rootNode.paneId;
    newTargetRoot = insertSplitAt(
      targetTab.rootNode,
      targetPaneId,
      direction,
      focusPaneId,
      position,
    );
  } else {
    focusPaneId = allPaneIds(sourceTab.rootNode)[0];
    newTargetRoot = insertSubtreeAt(
      targetTab.rootNode,
      targetPaneId,
      direction,
      sourceTab.rootNode,
      position,
    );
  }
  const effects: Partial<LayoutEffects> = {
    releasedPanes: allPaneIds(sourceTab.rootNode),
    selectTab: { panelId: targetPanel.id, tabId: targetTab.id },
    focusPane: { tabId: targetTab.id, paneId: focusPaneId },
  };

  if (sourcePanel.id === targetPanel.id) {
    const newTabs = sourcePanel.tabs
      .filter((t) => t.id !== sourceTab.id)
      .map((t) => (t.id === targetTab.id ? { ...t, rootNode: newTargetRoot } : t));
    return result(
      withPanel(layout, sourcePanel.id, (p) => ({
        ...p,
        tabs: newTabs,
        pinnedTabIds: (p.pinnedTabIds ?? []).filter((id) => id !== sourceTab.id),
      })),
      closedStack,
      effects,
    );
  }

  const withTarget: Record<string, Panel> = {
    ...layout.panels,
    [targetPanel.id]: {
      ...targetPanel,
      tabs: targetPanel.tabs.map((t) =>
        t.id === targetTab.id ? { ...t, rootNode: newTargetRoot } : t,
      ),
    },
  };
  const detached = detachTabFromPanel(
    withTarget,
    layout.panelTree,
    sourcePanel,
    sourceTab.id,
    command.fallbackTab,
  );

  return result(
    { ...layout, panelTree: detached.panelTree, panels: detached.panels },
    closedStack,
    { ...effects, activatePanel: targetPanel.id },
  );
}

function extractPaneToTab(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "extract-pane-to-tab" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const { paneId } = command;
  const src = findPanelWithPane(layout, paneId);
  if (!src) return unchanged(state);
  const { panel: sourcePanel, tab: sourceTab } = src;
  const destPanelId = command.targetPanelId ?? sourcePanel.id;
  const destPanel = layout.panels[destPanelId];
  if (!destPanel) return unchanged(state);

  const isSoleLeaf =
    sourceTab.rootNode.type === "leaf" && sourceTab.rootNode.paneId === paneId;

  // Already a tab of its own in the destination panel — nothing structural to
  // do at all. Selecting it is viewport, and the sender does it itself.
  if (isSoleLeaf && sourcePanel.id === destPanelId) return unchanged(state);

  const effects: Partial<LayoutEffects> = { releasedPanes: [paneId] };

  // Already a tab of its own — move the whole tab across.
  if (isSoleLeaf) {
    const withDest: Record<string, Panel> = {
      ...layout.panels,
      [destPanelId]: { ...destPanel, tabs: [...destPanel.tabs, sourceTab] },
    };
    const detached = detachTabFromPanel(
      withDest,
      layout.panelTree,
      sourcePanel,
      sourceTab.id,
      command.fallbackTab,
    );
    return result(
      { ...layout, panelTree: detached.panelTree, panels: detached.panels },
      closedStack,
      {
        ...effects,
        selectTab: { panelId: destPanelId, tabId: sourceTab.id },
        activatePanel: destPanelId,
      },
    );
  }

  const remaining = removePane(sourceTab.rootNode, paneId);
  if (!remaining) return unchanged(state);

  const newTab: Tab = {
    id: command.newTabId,
    title: "Terminal",
    rootNode: { type: "leaf", paneId },
  };
  const selection: Partial<LayoutEffects> = {
    selectTab: { panelId: destPanelId, tabId: newTab.id },
    focusPane: { tabId: newTab.id, paneId },
    activatePanel: destPanelId,
  };

  if (sourcePanel.id === destPanelId) {
    return result(
      withPanel(layout, sourcePanel.id, (p) => ({
        ...p,
        tabs: [
          ...p.tabs.map((t) =>
            t.id === sourceTab.id ? { ...t, rootNode: remaining } : t,
          ),
          newTab,
        ],
      })),
      closedStack,
      { ...effects, ...selection },
    );
  }

  return result(
    {
      ...layout,
      panels: {
        ...layout.panels,
        [sourcePanel.id]: {
          ...sourcePanel,
          tabs: sourcePanel.tabs.map((t) =>
            t.id === sourceTab.id ? { ...t, rootNode: remaining } : t,
          ),
        },
        [destPanelId]: { ...destPanel, tabs: [...destPanel.tabs, newTab] },
      },
    },
    closedStack,
    { ...effects, ...selection },
  );
}

function closePane(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "close-pane" }>,
  paneMetadata: PaneMetadataMap | undefined,
): LayoutResult {
  const { layout, closedStack } = state;
  const found = findPanelWithPane(layout, command.paneId);
  if (!found) return unchanged(state);
  const { panel, tab } = found;

  const remaining = removePane(tab.rootNode, command.paneId);
  // Last pane in the tab — the tab goes, and with it a tab-shaped undo entry.
  if (remaining === null) {
    return closeTab(state, tab.id, paneMetadata);
  }

  const meta = paneMetadata?.[command.paneId] ?? {};
  const entry: ClosedPaneEntry = {
    kind: "pane",
    paneId: command.paneId,
    tabId: tab.id,
    panelId: panel.id,
    ...meta,
  };

  return result(
    withTab(layout, panel.id, tab.id, (t) => ({ ...t, rootNode: remaining })),
    pushClosed(closedStack, entry),
    {
      killPanes: [command.paneId],
      focusPane: { tabId: tab.id, paneId: allPaneIds(remaining)[0] },
    },
  );
}

function reopenClosedPane(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "reopen-closed-pane" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const entry = closedStack[0];
  if (!entry) return unchanged(state);
  const nextStack = closedStack.slice(1);

  const fallbackPanelId = command.panelId ?? firstPanelId(layout);
  const targetPanelId = layout.panels[entry.panelId]
    ? entry.panelId
    : fallbackPanelId;
  const targetPanel = targetPanelId ? layout.panels[targetPanelId] : undefined;
  if (!targetPanel || !targetPanelId) return unchanged(state);

  if (entry.kind === "tab") {
    const firstPane = allPaneIds(entry.tab.rootNode)[0];
    // The tab's panel went with it — rebuild the panel where it stood.
    const sc = entry.panelSplitContext;
    if (!layout.panels[entry.panelId] && sc && layout.panels[sc.siblingId]) {
      const restoredPanel: Panel = {
        id: entry.panelId,
        tabs: [entry.tab],
        pinnedTabIds: [],
      };
      return result(
        {
          ...layout,
          panelTree: insertPanelSplit(
            layout.panelTree,
            sc.siblingId,
            sc.direction,
            entry.panelId,
            sc.position,
            sc.ratio,
          ),
          panels: { ...layout.panels, [entry.panelId]: restoredPanel },
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
      withPanel(layout, targetPanelId, (p) => ({
        ...p,
        tabs: [...p.tabs, entry.tab],
      })),
      nextStack,
      {
        selectTab: { panelId: targetPanelId, tabId: entry.tab.id },
        focusPane: { tabId: entry.tab.id, paneId: firstPane },
      },
    );
  }

  // A single pane: reuse its id so the daemon session (still alive during the
  // grace period) is reattached rather than a fresh shell spawned.
  const originalTab = targetPanel.tabs.find((t) => t.id === entry.tabId);
  if (originalTab) {
    const anchorPaneId =
      command.anchorPaneId ?? allPaneIds(originalTab.rootNode)[0];
    const rootNode = insertSplitAt(
      originalTab.rootNode,
      anchorPaneId,
      "horizontal",
      entry.paneId,
      "second",
      entry.contentType ?? "terminal",
    );
    return result(
      withPanel(layout, targetPanelId, (p) => ({
        ...p,
        tabs: p.tabs.map((t) =>
          t.id === originalTab.id ? { ...t, rootNode } : t,
        ),
      })),
      nextStack,
      {
        selectTab: { panelId: targetPanelId, tabId: originalTab.id },
        focusPane: { tabId: originalTab.id, paneId: entry.paneId },
      },
    );
  }

  const restoredTab: Tab = {
    id: command.newTabId,
    title: entry.title ?? "Terminal",
    rootNode: { type: "leaf", paneId: entry.paneId },
  };
  return result(
    withPanel(layout, targetPanelId, (p) => ({
      ...p,
      tabs: [...p.tabs, restoredTab],
    })),
    nextStack,
    {
      selectTab: { panelId: targetPanelId, tabId: restoredTab.id },
      focusPane: { tabId: restoredTab.id, paneId: entry.paneId },
    },
  );
}

function setPaneContentType(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "set-pane-content-type" }>,
): LayoutResult {
  const found = findPanelWithPane(state.layout, command.paneId);
  if (!found) return unchanged(state);
  const { panel, tab } = found;
  // "terminal" is the implicit default and is never written to the tree.
  const treeType =
    command.contentType === "terminal" ? undefined : command.contentType;
  let rootNode = updateLeafContentType(tab.rootNode, command.paneId, treeType);
  if (command.url !== undefined) {
    rootNode = updateLeafUrl(rootNode, command.paneId, command.url);
  }
  if (rootNode === tab.rootNode) return unchanged(state);
  return result(
    withTab(state.layout, panel.id, tab.id, (t) => ({ ...t, rootNode })),
    state.closedStack,
  );
}

function updateSplitRatio(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "update-split-ratio" }>,
): LayoutResult {
  const found = findPanelWithPane(state.layout, command.firstPaneId);
  if (!found) return unchanged(state);
  const { panel, tab } = found;
  const rootNode = updateRatio(tab.rootNode, command.firstPaneId, command.ratio);
  if (rootNode === tab.rootNode) return unchanged(state);
  return result(
    withTab(state.layout, panel.id, tab.id, (t) => ({ ...t, rootNode })),
    state.closedStack,
  );
}

// ──────────────────────────────── panels ─────────────────────────────────

function splitPanel(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "split-panel" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const panel = layout.panels[command.panelId];
  if (!panel) return unchanged(state);

  const movedTabId = command.tabId ?? panel.tabs[0]?.id;
  const movedTab = panel.tabs.find((t) => t.id === movedTabId);

  let sourceTabs: Tab[];
  let targetTabs: Tab[];

  if (movedTab) {
    sourceTabs = panel.tabs.filter((t) => t.id !== movedTab.id);
    if (sourceTabs.length === 0 && command.fallbackTab) {
      sourceTabs = [command.fallbackTab];
    }
    targetTabs = [movedTab];
  } else {
    // Nothing to move — the split just adds an empty panel.
    sourceTabs = panel.tabs;
    targetTabs = [];
  }

  return result(
    {
      ...layout,
      panelTree: insertPanelSplit(
        layout.panelTree,
        panel.id,
        command.direction,
        command.newPanelId,
      ),
      panels: {
        ...layout.panels,
        [panel.id]: { ...panel, tabs: sourceTabs },
        [command.newPanelId]: {
          id: command.newPanelId,
          tabs: targetTabs,
          pinnedTabIds: [],
        },
      },
    },
    closedStack,
    {
      activatePanel: command.newPanelId,
      ...(movedTab && {
        selectTab: { panelId: command.newPanelId, tabId: movedTab.id },
      }),
    },
  );
}

function closePanel(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "close-panel" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const panel = layout.panels[command.panelId];
  if (!panel) return unchanged(state);

  const effects = { killPanes: panelPaneIds(panel) };
  const panelTree = removePanelFromTree(layout.panelTree, command.panelId);
  const { [command.panelId]: _removed, ...remainingPanels } = layout.panels;

  // Last panel standing — leave an empty one behind so the workspace still
  // has somewhere to put a tab.
  if (panelTree === null) {
    const fallbackPanelId = command.fallbackPanelId ?? command.panelId;
    return result(
      createSinglePanelLayout(fallbackPanelId, [], []),
      closedStack,
      { ...effects, activatePanel: fallbackPanelId },
    );
  }

  const activatePanel =
    nextPanelId(panelTree, command.panelId) ?? allPanelIds(panelTree)[0];

  return result(
    { ...layout, panelTree, panels: remainingPanels },
    closedStack,
    { ...effects, ...(activatePanel && { activatePanel }) },
  );
}

function moveTabToPanel(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "move-tab-to-panel" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const src = findPanelWithTab(layout, command.tabId);
  if (!src) return unchanged(state);
  const { panel: sourcePanel, tab } = src;
  const targetPanel = layout.panels[command.targetPanelId];
  if (!targetPanel || sourcePanel.id === command.targetPanelId) {
    return unchanged(state);
  }

  const effects: Partial<LayoutEffects> = {
    releasedPanes: allPaneIds(tab.rootNode),
    selectTab: { panelId: command.targetPanelId, tabId: tab.id },
    activatePanel: command.targetPanelId,
  };
  const sourceTabs = sourcePanel.tabs.filter((t) => t.id !== command.tabId);
  const movedTarget: Panel = {
    ...targetPanel,
    tabs: [...targetPanel.tabs, tab],
  };

  if (sourceTabs.length === 0) {
    const panelTree = removePanelFromTree(layout.panelTree, sourcePanel.id);
    if (panelTree === null) return unchanged(state);
    const { [sourcePanel.id]: _removed, ...remainingPanels } = layout.panels;
    return result(
      {
        ...layout,
        panelTree,
        panels: { ...remainingPanels, [command.targetPanelId]: movedTarget },
      },
      closedStack,
      effects,
    );
  }

  return result(
    {
      ...layout,
      panels: {
        ...layout.panels,
        [sourcePanel.id]: {
          ...sourcePanel,
          tabs: sourceTabs,
          pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter(
            (id) => id !== command.tabId,
          ),
        },
        [command.targetPanelId]: movedTarget,
      },
    },
    closedStack,
    effects,
  );
}

function splitPanelWithTab(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "split-panel-with-tab" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const src = findPanelWithTab(layout, command.tabId);
  if (!src) return unchanged(state);
  const { panel: sourcePanel, tab } = src;
  if (!layout.panels[command.targetPanelId]) return unchanged(state);

  let sourceTabs = sourcePanel.tabs.filter((t) => t.id !== command.tabId);
  if (sourceTabs.length === 0 && command.fallbackTab) {
    sourceTabs = [command.fallbackTab];
  }

  return result(
    {
      ...layout,
      panelTree: insertPanelSplit(
        layout.panelTree,
        command.targetPanelId,
        command.direction,
        command.newPanelId,
      ),
      panels: {
        ...layout.panels,
        [sourcePanel.id]: {
          ...sourcePanel,
          tabs: sourceTabs,
          pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter(
            (id) => id !== command.tabId,
          ),
        },
        [command.newPanelId]: {
          id: command.newPanelId,
          tabs: [tab],
          pinnedTabIds: [],
        },
      },
    },
    closedStack,
    {
      releasedPanes: allPaneIds(tab.rootNode),
      selectTab: { panelId: command.newPanelId, tabId: tab.id },
      activatePanel: command.newPanelId,
    },
  );
}

function mergeTabIntoTab(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "merge-tab-into-tab" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  const { sourceTabId, targetTabId } = command;
  if (sourceTabId === targetTabId) return unchanged(state);
  const src = findPanelWithTab(layout, sourceTabId);
  const tgt = findPanelWithTab(layout, targetTabId);
  if (!src || !tgt) return unchanged(state);
  const { panel: sourcePanel, tab: sourceTab } = src;
  const { panel: targetPanel, tab: targetTab } = tgt;

  // The whole source subtree grafts in as one side of a new split; nothing is
  // minted, which is why this cannot be expressed as `move-tab-to-pane` for a
  // multi-pane source.
  const position = command.position ?? "second";
  const rootNode: PaneNode = {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    first: position === "second" ? targetTab.rootNode : sourceTab.rootNode,
    second: position === "second" ? sourceTab.rootNode : targetTab.rootNode,
  };
  const focusedPaneId = allPaneIds(sourceTab.rootNode)[0];
  const effects: Partial<LayoutEffects> = {
    releasedPanes: allPaneIds(sourceTab.rootNode),
    selectTab: { panelId: targetPanel.id, tabId: targetTabId },
    focusPane: { tabId: targetTabId, paneId: focusedPaneId },
  };

  if (sourcePanel.id === targetPanel.id) {
    const tabs = sourcePanel.tabs
      .filter((t) => t.id !== sourceTabId)
      .map((t) => (t.id === targetTabId ? { ...t, rootNode } : t));
    return result(
      withPanel(layout, sourcePanel.id, (p) => ({
        ...p,
        tabs,
        pinnedTabIds: (p.pinnedTabIds ?? []).filter((id) => id !== sourceTabId),
      })),
      closedStack,
      effects,
    );
  }

  const withTarget: Record<string, Panel> = {
    ...layout.panels,
    [targetPanel.id]: {
      ...targetPanel,
      tabs: targetPanel.tabs.map((t) =>
        t.id === targetTabId ? { ...t, rootNode } : t,
      ),
    },
  };
  const detached = detachTabFromPanel(
    withTarget,
    layout.panelTree,
    sourcePanel,
    sourceTabId,
    command.fallbackTab,
  );

  return result(
    { ...layout, panelTree: detached.panelTree, panels: detached.panels },
    closedStack,
    { ...effects, activatePanel: targetPanel.id },
  );
}

function splitPanelWithNewTab(
  state: LayoutState,
  command: Extract<LayoutCommand, { type: "split-panel-with-new-tab" }>,
): LayoutResult {
  const { layout, closedStack } = state;
  if (!layout.panels[command.sourcePanelId]) return unchanged(state);

  return result(
    {
      ...layout,
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
        paneId: allPaneIds(command.tab.rootNode)[0],
      },
      activatePanel: command.newPanelId,
    },
  );
}
