import { create } from "zustand";
import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  clonePaneTree,
  hasPaneId,
  removePane,
  nextPaneId,
  prevPaneId,
  updateLeafUrl,
} from "../lib/layout/pane-tree";
import {
  allPanelIds,
  insertPanelSplit,
  removePanel as removePanelFromTree,
  nextPanelId,
  prevPanelId,
} from "../lib/layout/panel-tree";
import {
  type Panel,
  type Tab,
  type WorkspaceLayout,
  createSinglePanelLayout,
  findPanelWithPane,
  findPanelWithTab,
} from "../lib/layout/workspace-layout";
import {
  type ClosedPane,
  type LayoutCommand,
  type LayoutEffects,
  type PaneMetadataMap,
  applyLayoutCommand,
} from "../lib/layout/commands";
import type {
  PersistedWorkspace,
  PersistedPanel,
  PersistedTab,
  PersistedLayout,
  AgentState,
  PickedElementResult,
} from "../electron.d";
import type { SetupStep, StepStatus } from "./project-store";
import type { Location } from "./navigation-history-store";
import type { DetachedTabPayload } from "./detach-types";
import { isHomePath } from "../lib/home-path";
import { useProjectStore } from "./project-store";
import { BridgeUnavailableError } from "../web/ws-bridge";
import { showBridgeUnavailableToastOnce } from "../lib/bridge-unavailable-toast";

/**
 * The reopen stack is reducer state (ADR-179 D3). The store keeps one stack
 * across every workspace while the reducer works on one workspace at a time,
 * so a store entry is a reducer entry plus the workspace it came from.
 */
export type ClosedPaneSnapshot = Extract<ClosedPane, { kind: "pane" }> & {
  workspacePath: string;
};
export type ClosedTabSnapshot = Extract<ClosedPane, { kind: "tab" }> & {
  workspacePath: string;
};
type ClosedSnapshot = ClosedPaneSnapshot | ClosedTabSnapshot;

function newPaneId(): string {
  return `pane-${crypto.randomUUID()}`;
}

function newTabId(): string {
  return `tab-${crypto.randomUUID()}`;
}

export type { Panel, Tab, WorkspaceLayout };

function createTab(title?: string, paneId?: string): Tab {
  const id = paneId ?? newPaneId();
  return {
    id: newTabId(),
    title: title ?? "Terminal",
    rootNode: { type: "leaf", paneId: id },
    focusedPaneId: id,
  };
}

function newPanelId(): string {
  return `panel-${crypto.randomUUID()}`;
}

function createEmptyLayout(): WorkspaceLayout {
  return createSinglePanelLayout(newPanelId(), [], "", []);
}

/** Convert a PersistedWorkspace back into a WorkspaceLayout.
 *  Handles both v1 (flat tabs) and v2 (panel tree) formats — the electron
 *  main process may not have restarted yet during dev HMR. */
function restoreWorkspaceState(
  persisted: PersistedWorkspace,
): WorkspaceLayout {
  // v1 format: has `tabs` array at top level, no `panels`
  const v1 = persisted as unknown as { tabs?: PersistedTab[]; selectedTabId?: string; pinnedTabIds?: string[] };
  if (!persisted.panels && v1.tabs) {
    const tabs: Tab[] = v1.tabs.map((pt) => ({
      id: pt.id,
      title: pt.title,
      rootNode: pt.rootNode,
      focusedPaneId: pt.focusedPaneId,
    }));
    if (tabs.length === 0) return createEmptyLayout();
    return createSinglePanelLayout(
      newPanelId(),
      tabs,
      v1.selectedTabId || tabs[0].id,
      v1.pinnedTabIds ?? [],
    );
  }

  // v2 format: has panel tree
  const panels: Record<string, Panel> = {};
  for (const [panelId, pp] of Object.entries(persisted.panels ?? {})) {
    panels[panelId] = {
      id: pp.id,
      tabs: pp.tabs.map((pt) => ({
        id: pt.id,
        title: pt.title,
        rootNode: pt.rootNode,
        focusedPaneId: pt.focusedPaneId,
      })),
      selectedTabId: pp.selectedTabId,
      pinnedTabIds: pp.pinnedTabIds ?? [],
    };
  }

  const hasTabs = Object.values(panels).some((p) => p.tabs.length > 0);
  if (!hasTabs) {
    return createEmptyLayout();
  }

  return {
    panelTree: persisted.panelTree,
    panels,
    activePanelId: persisted.activePanelId,
  };
}

export interface AppState {
  workspaceLayouts: Record<string, WorkspaceLayout>;
  activeWorkspacePath: string | null;
  paneCwd: Record<string, string>;
  paneTitle: Record<string, string>;
  paneAgentStatus: Record<string, AgentState>;
  paneContentType: Record<string, "terminal" | "browser" | "diff">;
  paneFavicon: Record<string, string>;
  paneAudioPlaying: Record<string, boolean>;
  paneAudioMuted: Record<string, boolean>;
  /** Recording start timestamp (ms epoch) per pane, while capture is live (ADR-158). */
  paneRecordingStartedAt: Record<string, number>;
  paneUrl: Record<string, string>;
  panePickedElement: Record<string, PickedElementResult>;
  webviewFocusedPaneId: string | null;
  layoutLoaded: boolean;
  /** Pane IDs that were explicitly closed by the user (should be killed, not detached) */
  closedPaneIds: Set<string>;
  /** Stack of recently closed pane snapshots for reopen (LIFO, max 10) */
  closedPaneStack: ClosedSnapshot[];
  /** Pending startup commands to run in new terminals (workspace path → script) */
  pendingStartupCommands: Record<string, string>;
  /** Pending startup commands keyed by pane ID (for split-with-agent) */
  pendingPaneCommands: Record<string, string>;
  /** Pane ID awaiting close confirmation (when agent is active) */
  pendingCloseConfirmPaneId: string | null;
  /** Tab ID awaiting close confirmation (when agent is active in a pane) */
  pendingCloseConfirmTabId: string | null;
  // Workspace activation
  setActiveWorkspace: (path: string) => void;

  /**
   * Atomically navigate to a specific pane inside a workspace.
   * Sets activeWorkspacePath, activePanelId, selectedTabId, and focusedPaneId
   * in a single Zustand set() call so subscribers see no intermediate states.
   * Bails (no state change) if the workspacePath has no layout or the tabId
   * does not exist in any panel.
   */
  navigateToContext: (ctx: {
    workspacePath: string;
    tabId: string;
    paneId: string;
  }) => void;

  // Layout restore — called once on startup
  loadPersistedLayout: () => Promise<void>;

  // Tab operations
  /**
   * Returns the IDs of the tab it created, or null when there is no active
   * panel. `adoptPaneId` lets the new pane reuse a PTY session main already
   * prewarmed under that ID; everything else lets the store mint one.
   */
  addTab: (adoptPaneId?: string) => { tabId: string; paneId: string } | null;
  addTerminalTab: (command: string) => { tabId: string; paneId: string } | null;
  addBrowserTab: (
    url: string,
    opts?: { background?: boolean },
  ) => { tabId: string; paneId: string } | null;
  addDiffTab: () => void;
  duplicateTab: (tabId: string) => void;
  openOrFocusDiff: () => void;
  openDiffInNewPanel: () => void;
  closeTab: (tabId: string) => void;
  /** Close every other (unpinned) tab in the same panel as `tabId`. */
  closeOtherTabs: (tabId: string) => void;
  /** Close every (unpinned) tab positioned after `tabId` in its panel. */
  closeTabsToRight: (tabId: string) => void;
  requestCloseTab: (tabId: string) => void;
  setPendingCloseConfirmTabId: (tabId: string | null) => void;
  selectTab: (tabId: string) => void;
  /** Select a tab by global index across all panels (for cmd+1..9 shortcuts). */
  selectTabByGlobalIndex: (index: number) => void;
  selectNextTab: () => void;
  selectPrevTab: () => void;
  reorderTabs: (tabIds: string[]) => void;
  togglePinTab: (tabId: string) => void;

  // Pane operations
  splitPane: (direction: SplitDirection) => void;
  /** Returns the minted paneId, or null when the target pane does not exist. */
  splitPaneAt: (
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
    opts?: {
      contentType?: "terminal" | "browser" | "diff" | "agent";
      paneCommand?: string;
      url?: string;
    },
  ) => string | null;
  movePaneToTarget: (
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => void;
  moveTabToPane: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => void;
  extractPaneToTab: (paneId: string, targetPanelId?: string) => void;
  closePane: () => void;
  closePaneById: (paneId: string) => void;
  reopenClosedPane: () => void;
  requestClosePane: () => void;
  requestClosePaneById: (paneId: string) => void;
  setPendingCloseConfirmPaneId: (paneId: string | null) => void;
  focusPane: (paneId: string) => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;
  /**
   * Bumped by `refocusActivePane`. The terminal's auto-focus effect depends on
   * it, so a bump is an explicit "put the keyboard back in the pane" even when
   * the effect would otherwise leave focus where it is (ADR-172).
   */
  paneFocusNonce: number;
  /** Sends keyboard focus back to the focused pane of the active tab. */
  refocusActivePane: () => void;

  // CWD tracking
  setPaneCwd: (paneId: string, cwd: string) => void;

  // Title tracking (from terminal OSC sequences)
  setPaneTitle: (paneId: string, title: string) => void;
  clearPaneTitle: (paneId: string) => void;

  // Pane content type
  setPaneContentType: (
    paneId: string,
    contentType: "terminal" | "browser" | "diff",
  ) => void;

  // Browser favicon
  setPaneFavicon: (paneId: string, favicon: string | null) => void;

  // Browser audio state
  setPaneAudioPlaying: (paneId: string, playing: boolean) => void;
  setPaneAudioMuted: (paneId: string, muted: boolean) => void;

  /**
   * Recording state (ADR-158). `startedAt` (not a boolean) so the pane's
   * "Recording" indicator can render elapsed time without a second lookup.
   * Set/cleared from `App.tsx`'s "webview:recording-command" subscription —
   * main owns the recording lifecycle, the renderer just mirrors it. Pass
   * `null` to clear.
   */
  setPaneRecordingStartedAt: (paneId: string, startedAt: number | null) => void;

  // Browser URL tracking
  setPaneUrl: (paneId: string, url: string) => void;

  // Agent status tracking
  setPaneAgentStatus: (paneId: string, agent: AgentState) => void;

  // Startup commands
  setPendingStartupCommand: (workspacePath: string, command: string) => void;
  consumePendingStartupCommand: (workspacePath: string) => string | null;
  consumePendingPaneCommand: (paneId: string) => string | null;

  // Workspace cleanup
  removeWorkspaceLayout: (workspacePath: string) => void;

  // Panel operations
  splitPanel: (direction: SplitDirection) => void;
  closePanel: (panelId: string) => void;
  focusPanel: (panelId: string) => void;
  focusNextPanel: () => void;
  focusPrevPanel: () => void;
  updatePanelSplitRatio: (firstPanelId: string, ratio: number) => void;
  moveTabToPanel: (tabId: string, targetPanelId: string) => void;
  splitPanelWithTab: (tabId: string, targetPanelId: string, direction: SplitDirection) => void;
  mergeTabIntoTab: (sourceTabId: string, targetTabId: string) => void;

  // Worktree setup progress tracking
  worktreeSetupState: Record<
    string,
    {
      steps: Array<{ step: SetupStep; status: StepStatus; message?: string }>;
      completed: boolean;
      startScript?: string | null;
      workspacePath?: string;
    }
  >;
  initWorktreeSetup: (
    wsPathHint: string,
    hasStartScript: boolean,
    startScript?: string | null,
  ) => void;
  updateWorktreeSetupStep: (
    wsPath: string,
    step: SetupStep,
    status: StepStatus,
    message?: string,
  ) => void;
  completeWorktreeSetup: (wsPath: string) => void;
  clearWorktreeSetup: (wsPath: string) => void;
  migrateWorktreeSetupPath: (fromKey: string, toKey: string) => void;

  // Resize
  updateSplitRatio: (firstPaneId: string, ratio: number) => void;

  // Webview focus
  setWebviewFocused: (paneId: string, focused: boolean) => void;

  // Picked element
  setPickedElement: (paneId: string, result: PickedElementResult) => void;
  clearPickedElement: (paneId: string) => void;

  // Multi-window detach / reattach (ADR-156)
  /**
   * Serialize a tab (by id) into a structured-clone-safe payload for handoff to
   * a detached popup window. Copies the tab shape plus every per-pane side-map
   * entry. Searches all workspace layouts; throws if the tab is not found.
   */
  serializeTabForDetach: (tabId: string) => DetachedTabPayload;
  /**
   * Remove a tab from its panel WITHOUT killing its panes: terminals are
   * `pty.detach`ed (session survives in the daemon), browsers are
   * `webview.unregister`ed, diffs need no teardown. Collapses an emptied panel
   * the same way `closeTab` does, and drops the tab's per-pane side-map entries.
   * Distinct from `closeTab`, which terminates the sessions.
   */
  removeDetachedTabLocally: (tabId: string) => void;
  /**
   * Serialize a single pane (by id) into a `DetachedTabPayload` for handoff to a
   * detached popup window — a detached pane is just a tab whose rootNode is a
   * single leaf. Mints a fresh tab id, copies only this pane's side-map entries,
   * and resolves theme/workspace like `serializeTabForDetach`. Throws if the
   * pane is not found in any workspace layout.
   */
  serializePaneForDetach: (paneId: string) => DetachedTabPayload;
  /**
   * Remove a single pane from its source tab WITHOUT killing it: terminals are
   * `pty.detach`ed, browsers are `webview.unregister`ed, diffs need no teardown.
   * Collapses the split via `removePane`; if the pane was the tab's sole leaf,
   * removes the whole tab exactly as `removeDetachedTabLocally` does. Keeps the
   * backend alive so the pane re-attaches in the destination window.
   */
  removeDetachedPaneLocally: (paneId: string) => void;
  /**
   * Rebuild a minimal one-panel/one-tab layout from a detach payload in a fresh
   * (detached-window) store and repopulate every per-pane side-map, so the
   * normal render path re-attaches PTYs / re-mounts webviews by paneId. Reuses
   * the payload's original paneIds — never mints new ones.
   */
  hydrateDetachedTab: (payload: DetachedTabPayload) => void;
  /**
   * Receive a tab reattached from a detached window into THIS (primary) window.
   * Inserts the tab into the active panel of the active workspace layout
   * (appends to its tabs, selects it) and repopulates every per-pane side-map
   * from the payload — so PTYs re-attach and webviews re-mount by paneId,
   * exactly like `hydrateDetachedTab` but into the existing layout. The normal
   * layout-save subscription then persists it, making the tab durable again.
   */
  receiveReattachedTab: (payload: DetachedTabPayload) => void;
}

// Selector for the active workspace's active panel (backward compat: same shape as old WorkspaceTabState)
export function selectActiveWorkspace(
  state: AppState,
): Panel | null {
  if (!state.activeWorkspacePath) return null;
  const layout = state.workspaceLayouts[state.activeWorkspacePath];
  if (!layout) return null;
  return layout.panels[layout.activePanelId] ?? null;
}

/**
 * True when the browser pane holding webview focus is actually on screen: in
 * the active workspace, inside a panel's *selected* tab. Hidden tabs stay
 * mounted and webviews don't always blur when their tab is hidden, so the
 * status-bar badge must be gated on visibility, not on the raw pane id.
 */
export function selectWebviewFocusVisible(state: AppState): boolean {
  const paneId = state.webviewFocusedPaneId;
  if (!paneId) return false;
  const ctx = getActiveLayoutContext(state);
  if (!ctx) return false;
  return Object.values(ctx.layout.panels).some((panel) => {
    const tab = panel.tabs.find((t) => t.id === panel.selectedTabId);
    return tab ? hasPaneId(tab.rootNode, paneId) : false;
  });
}

/**
 * Every pane the user can currently see: in the active workspace, inside each
 * panel's *selected* tab.
 *
 * Panels sit side by side, so a pane in a non-active panel is on screen too —
 * `activePanelId` only says where focus lives, not what is rendered. Hidden
 * tabs stay mounted, so membership in a tab's tree is not enough on its own.
 *
 * This is the single definition of "on screen" for read state (issue #142): a
 * agent whose pane is in this set has been seen, whether the user got there by
 * clicking the agent, switching tabs, focusing a pane, or changing workspace.
 */
export function selectVisiblePaneIds(
  state: Pick<AppState, "activeWorkspacePath" | "workspaceLayouts">,
): Set<string> {
  const ids = new Set<string>();
  const path = state.activeWorkspacePath;
  if (!path) return ids;
  const layout = state.workspaceLayouts[path];
  if (!layout) return ids;
  for (const panel of Object.values(layout.panels)) {
    const tab = panel.tabs.find((t) => t.id === panel.selectedTabId);
    if (!tab) continue;
    for (const id of allPaneIds(tab.rootNode)) ids.add(id);
  }
  return ids;
}

/**
 * Derive the current navigable `Location` from layout state. This is the read
 * side of the navigation-history bridge: `app-store` remains the source of
 * truth for "where am I", and the history store only records what this returns.
 *
 * Home (or no active workspace) collapses to the `home` surface — panel/tab
 * coordinates inside Home are intentionally not tracked. Any project workspace
 * maps to its active panel's selected tab.
 */
export function selectCurrentLocation(state: AppState): Location {
  const path = state.activeWorkspacePath;
  if (!path || isHomePath(path)) {
    return { kind: "surface", surface: "home" };
  }
  const ctx = getActivePanelContext(state);
  if (!ctx) {
    return { kind: "surface", surface: "home" };
  }
  return {
    kind: "workspace",
    workspacePath: ctx.path,
    panelId: ctx.panel.id,
    tabId: ctx.panel.selectedTabId,
  };
}

// Internal helpers for active panel context
function getActivePanelContext(state: AppState): { path: string; layout: WorkspaceLayout; panel: Panel } | null {
  const path = state.activeWorkspacePath;
  if (!path) return null;
  const layout = state.workspaceLayouts[path];
  if (!layout) return null;
  const panel = layout.panels[layout.activePanelId];
  if (!panel) return null;
  return { path, layout, panel };
}

function getActiveLayoutContext(state: AppState): { path: string; layout: WorkspaceLayout } | null {
  const path = state.activeWorkspacePath;
  if (!path) return null;
  const layout = state.workspaceLayouts[path];
  if (!layout) return null;
  return { path, layout };
}

/** Build a flat list of { tabId, panelId } in tree-traversal order across all panels. */
function globalTabList(layout: WorkspaceLayout): Array<{ tabId: string; panelId: string }> {
  const panelIds = allPanelIds(layout.panelTree);
  const result: Array<{ tabId: string; panelId: string }> = [];
  for (const pid of panelIds) {
    const panel = layout.panels[pid];
    if (!panel) continue;
    for (const tab of panel.tabs) {
      result.push({ tabId: tab.id, panelId: pid });
    }
  }
  return result;
}

function updatePanel(
  state: AppState,
  path: string,
  layout: WorkspaceLayout,
  panelId: string,
  updater: (panel: Panel) => Panel,
): Partial<AppState> {
  const panel = layout.panels[panelId];
  if (!panel) return {};
  return {
    workspaceLayouts: {
      ...state.workspaceLayouts,
      [path]: {
        ...layout,
        panels: { ...layout.panels, [panelId]: updater(panel) },
      },
    },
  };
}

// ── Layout commands (ADR-179 D1/D2) ──
//
// Structure is owned by the pure reducer in `src/lib/layout/commands.ts`. An
// action's job is to resolve what "current" means from its own viewport, mint
// any new ids, hand the reducer a command, and then do the impure half — the
// per-pane side maps and the host bookkeeping the reducer reports in
// `effects`. Ticket 2 of ADR-179 moves the reducer call itself to the server;
// everything on this side of it stays where it is.

/** Split the one cross-workspace reopen stack into this workspace's and the rest. */
function splitClosedStack(
  stack: ClosedSnapshot[],
  path: string,
): { mine: ClosedPane[]; others: ClosedSnapshot[] } {
  const mine: ClosedPane[] = [];
  const others: ClosedSnapshot[] = [];
  for (const entry of stack) {
    if (entry.workspacePath === path) mine.push(entry);
    else others.push(entry);
  }
  return { mine, others };
}

function mergeClosedStack(
  mine: ClosedPane[],
  others: ClosedSnapshot[],
  path: string,
): ClosedSnapshot[] {
  const mineWithPath = mine.map(
    (entry) => ({ ...entry, workspacePath: path }) as ClosedSnapshot,
  );
  return [...mineWithPath, ...others];
}

/**
 * The per-pane side state the reopen stack needs, for every pane of the active
 * workspace. Closing commands carry it because the reducer does not own these
 * maps yet (ADR-179 ticket 2 folds them in as `paneSessions`).
 */
function activeWorkspacePaneMetadata(state: AppState): PaneMetadataMap {
  const path = state.activeWorkspacePath;
  const layout = path ? state.workspaceLayouts[path] : undefined;
  if (!layout) return {};
  const metadata: PaneMetadataMap = {};
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) {
      for (const pid of allPaneIds(tab.rootNode)) {
        metadata[pid] = {
          contentType: state.paneContentType[pid],
          url: state.paneUrl[pid],
          cwd: state.paneCwd[pid],
          title: state.paneTitle[pid],
        };
      }
    }
  }
  return metadata;
}

interface LayoutCommandOutcome {
  /** Zustand patch: layout, reopen stack, and side-map cleanup. */
  patch: Partial<AppState>;
  effects: LayoutEffects;
  changed: boolean;
}

const UNCHANGED_OUTCOME: LayoutCommandOutcome = {
  patch: {},
  effects: { killPanes: [], releasedPanes: [] },
  changed: false,
};

/**
 * Run a layout command against the active workspace and fold the result into a
 * store patch: the new layout, the reopen stack, and the bookkeeping for panes
 * that left the tree for good — marked in `closedPaneIds`, which is what makes
 * the terminal's unmount schedule a kill instead of a detach, and dropped from
 * every per-pane side map.
 *
 * A command naming an unknown id changes nothing, and the patch is empty — so
 * `workspaceLayouts` comes out identical by reference.
 */
function runLayoutCommand(
  state: AppState,
  command: LayoutCommand,
): LayoutCommandOutcome {
  const path = state.activeWorkspacePath;
  if (!path) return UNCHANGED_OUTCOME;
  const layout = state.workspaceLayouts[path];
  if (!layout) return UNCHANGED_OUTCOME;

  const { mine, others } = splitClosedStack(state.closedPaneStack, path);
  const next = applyLayoutCommand({ layout, closedStack: mine }, command);
  if (next.layout === layout && next.closedStack === mine) {
    return UNCHANGED_OUTCOME;
  }

  const patch: Partial<AppState> = {};
  if (next.layout !== layout) {
    patch.workspaceLayouts = { ...state.workspaceLayouts, [path]: next.layout };
  }
  if (next.closedStack !== mine) {
    patch.closedPaneStack = mergeClosedStack(next.closedStack, others, path);
  }

  if (next.effects.killPanes.length > 0) {
    const closedPaneIds = new Set(state.closedPaneIds);
    const paneCwd = { ...state.paneCwd };
    const paneTitle = { ...state.paneTitle };
    const paneAgentStatus = { ...state.paneAgentStatus };
    const paneContentType = { ...state.paneContentType };
    const paneUrl = { ...state.paneUrl };
    const pendingPaneCommands = { ...state.pendingPaneCommands };
    for (const paneId of next.effects.killPanes) {
      closedPaneIds.add(paneId);
      delete paneCwd[paneId];
      delete paneTitle[paneId];
      delete paneAgentStatus[paneId];
      delete paneContentType[paneId];
      delete paneUrl[paneId];
      delete pendingPaneCommands[paneId];
    }
    Object.assign(patch, {
      closedPaneIds,
      paneCwd,
      paneTitle,
      paneAgentStatus,
      paneContentType,
      paneUrl,
      pendingPaneCommands,
    });
  }

  return { patch, effects: next.effects, changed: true };
}

// Cache the loaded layout so setActiveWorkspace can check it synchronously
let _cachedLayout: PersistedLayout | null = null;

/**
 * The workspace/surface path that was active when the layout was last persisted
 * (includes the Home surface's `HOME_PATH`). Populated by `loadPersistedLayout`;
 * used by the boot sequence to restore the last-active surface on relaunch.
 * Returns `null` when there is no persisted layout or the field is absent.
 */
export function getPersistedActiveWorkspacePath(): string | null {
  return _cachedLayout?.lastActiveWorkspacePath ?? null;
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaceLayouts: {},
  activeWorkspacePath: null,
  paneCwd: {},
  paneTitle: {},
  paneAgentStatus: {},
  paneContentType: {},
  paneFavicon: {},
  paneAudioPlaying: {},
  paneAudioMuted: {},
  paneRecordingStartedAt: {},
  paneUrl: {},
  panePickedElement: {},
  webviewFocusedPaneId: null,
  layoutLoaded: false,
  paneFocusNonce: 0,
  closedPaneIds: new Set<string>(),
  closedPaneStack: [],
  pendingStartupCommands: {},
  pendingPaneCommands: {},
  pendingCloseConfirmPaneId: null,
  pendingCloseConfirmTabId: null,
  worktreeSetupState: {},

  loadPersistedLayout: async () => {
    try {
      const layout = await window.electronAPI?.layout.load();
      if (layout) {
        _cachedLayout = layout;

        // Pre-populate paneCwd, paneTitle, paneAgentStatus, paneContentType,
        // and paneUrl from persisted data
        const cwds: Record<string, string> = {};
        const titles: Record<string, string> = {};
        const agents: Record<string, AgentState> = {};
        const contentTypes: Record<string, "terminal" | "browser" | "diff"> =
          {};
        const urls: Record<string, string> = {};
        for (const ws of layout.workspaces) {
          // Handle both v1 (flat tabs) and v2 (panels) formats
          const v1ws = ws as unknown as { tabs?: PersistedTab[] };
          const allTabs: PersistedTab[] = ws.panels
            ? Object.values(ws.panels).flatMap((p) => p.tabs)
            : (v1ws.tabs ?? []);
          for (const tab of allTabs) {
            for (const [paneId, paneSession] of Object.entries(
              tab.paneSessions,
            )) {
              if (paneSession.lastCwd) {
                cwds[paneId] = paneSession.lastCwd;
              }
              if (paneSession.lastTitle) {
                titles[paneId] = paneSession.lastTitle;
              }
              if (
                paneSession.lastAgentStatus &&
                !(
                  paneSession.lastAgentStatus.status === "idle" &&
                  paneSession.lastAgentStatus.kind === null
                )
              ) {
                agents[paneId] = paneSession.lastAgentStatus as AgentState;
              }
            }
            const extractLeafData = (node: PaneNode): void => {
              if (node.type === "leaf") {
                if (node.contentType) {
                  contentTypes[node.paneId] = node.contentType;
                }
                if (node.url) {
                  urls[node.paneId] = node.url;
                }
              } else {
                extractLeafData(node.first);
                extractLeafData(node.second);
              }
            };
            extractLeafData(tab.rootNode);
          }
        }

        set({
          layoutLoaded: true,
          paneCwd: { ...get().paneCwd, ...cwds },
          paneTitle: { ...get().paneTitle, ...titles },
          paneAgentStatus: { ...get().paneAgentStatus, ...agents },
          paneContentType: { ...get().paneContentType, ...contentTypes },
          paneUrl: { ...get().paneUrl, ...urls },
        });
      } else {
        set({ layoutLoaded: true });
      }
    } catch {
      set({ layoutLoaded: true });
    }
  },

  setActiveWorkspace: (path: string) =>
    set((state) => {
      // Already initialized for this workspace
      if (state.workspaceLayouts[path]) {
        return { activeWorkspacePath: path };
      }

      // Check persisted layout for this workspace
      if (_cachedLayout) {
        const persisted = _cachedLayout.workspaces.find(
          (w) => w.workspacePath === path,
        );
        if (persisted) {
          const restored = restoreWorkspaceState(persisted);
          // Only use restored layout if it has tabs
          const hasTabs = Object.values(restored.panels).some(
            (p) => p.tabs.length > 0,
          );
          if (hasTabs) {
            return {
              activeWorkspacePath: path,
              workspaceLayouts: {
                ...state.workspaceLayouts,
                [path]: restored,
              },
            };
          }
        }
      }

      // No persisted state — start empty so WorkspaceEmptyState is shown
      return {
        activeWorkspacePath: path,
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: createEmptyLayout(),
        },
      };
    }),

  navigateToContext: ({ workspacePath, tabId, paneId }) =>
    set((state) => {
      const layout = state.workspaceLayouts[workspacePath];
      if (!layout) return state;

      // Find the panel that contains the requested tab
      const entry = findPanelWithTab(layout, tabId);
      if (!entry) return state;

      const { panel } = entry;

      return {
        activeWorkspacePath: workspacePath,
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [workspacePath]: {
            ...layout,
            activePanelId: panel.id,
            panels: {
              ...layout.panels,
              [panel.id]: {
                ...panel,
                selectedTabId: tabId,
                tabs: panel.tabs.map((t) =>
                  t.id === tabId ? { ...t, focusedPaneId: paneId } : t,
                ),
              },
            },
          },
        },
      };
    }),

  addTab: (adoptPaneId?: string) => {
    const ctx = getActivePanelContext(get());
    if (!ctx) return null;
    const tab = createTab(undefined, adoptPaneId);
    set(
      runLayoutCommand(get(), {
        type: "new-tab",
        tab,
        panelId: ctx.panel.id,
      }).patch,
    );
    return { tabId: tab.id, paneId: tab.focusedPaneId };
  },

  addTerminalTab: (command: string) => {
    const ctx = getActivePanelContext(get());
    if (!ctx) return null;
    const tab = createTab();
    const tabPaneId = tab.focusedPaneId;
    const state = get();
    set({
      ...runLayoutCommand(state, {
        type: "new-tab",
        tab,
        panelId: ctx.panel.id,
      }).patch,
      pendingPaneCommands: {
        ...state.pendingPaneCommands,
        [tabPaneId]: command,
      },
    });
    return { tabId: tab.id, paneId: tabPaneId };
  },

  addBrowserTab: (url: string, opts?: { background?: boolean }) => {
    const ctx = getActivePanelContext(get());
    if (!ctx) return null;
    const paneId = newPaneId();
    let title: string;
    try {
      const parsed = new URL(url);
      title = parsed.host || url;
    } catch {
      title = url;
    }
    const tab: Tab = {
      id: newTabId(),
      title,
      rootNode: { type: "leaf", paneId, contentType: "browser", url },
      focusedPaneId: paneId,
    };
    const background = opts?.background ?? false;
    const state = get();
    set({
      paneContentType: { ...state.paneContentType, [paneId]: "browser" },
      paneUrl: { ...state.paneUrl, [paneId]: url },
      ...runLayoutCommand(state, {
        type: "new-tab",
        tab,
        panelId: ctx.panel.id,
        select: !background,
      }).patch,
    });
    return { tabId: tab.id, paneId };
  },

  addDiffTab: () =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const paneId = newPaneId();
      const tab: Tab = {
        id: newTabId(),
        title: "Diff",
        rootNode: { type: "leaf", paneId, contentType: "diff" },
        focusedPaneId: paneId,
      };
      return {
        paneContentType: { ...state.paneContentType, [paneId]: "diff" },
        ...runLayoutCommand(state, {
          type: "new-tab",
          tab,
          panelId: ctx.panel.id,
        }).patch,
      };
    }),

  duplicateTab: (tabId: string) =>
    set((state) => {
      const wsPath = state.activeWorkspacePath;
      if (!wsPath) return state;
      const layout = state.workspaceLayouts[wsPath];
      if (!layout) return state;
      const found = findPanelWithTab(layout, tabId);
      if (!found) return state;
      const sourceTab = found.tab;

      const { tree: clonedRoot, idMap } = clonePaneTree(
        sourceTab.rootNode,
        newPaneId,
      );
      const nextContentType = { ...state.paneContentType };
      const nextUrl = { ...state.paneUrl };
      for (const [oldId, newId] of Object.entries(idMap)) {
        const ct = state.paneContentType[oldId];
        if (ct) nextContentType[newId] = ct;
        const u = state.paneUrl[oldId];
        if (u !== undefined) nextUrl[newId] = u;
      }

      const newTab: Tab = {
        id: newTabId(),
        title: sourceTab.title,
        rootNode: clonedRoot,
        focusedPaneId: idMap[sourceTab.focusedPaneId] ?? allPaneIds(clonedRoot)[0],
      };
      return {
        paneContentType: nextContentType,
        paneUrl: nextUrl,
        ...runLayoutCommand(state, {
          type: "duplicate-tab",
          tabId,
          newTab,
        }).patch,
      };
    }),

  openOrFocusDiff: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout) return state;

      // Look for an existing diff pane across ALL panels' tabs
      for (const [pId, panel] of Object.entries(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const paneId of allPaneIds(tab.rootNode)) {
            if (state.paneContentType[paneId] === "diff") {
              return {
                workspaceLayouts: {
                  ...state.workspaceLayouts,
                  [path]: {
                    ...layout,
                    activePanelId: pId,
                    panels: {
                      ...layout.panels,
                      [pId]: {
                        ...panel,
                        selectedTabId: tab.id,
                        tabs: panel.tabs.map((s) =>
                          s.id === tab.id ? { ...s, focusedPaneId: paneId } : s,
                        ),
                      },
                    },
                  },
                },
              };
            }
          }
        }
      }

      // No existing diff pane found — create a new diff tab in the active panel
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const paneId = newPaneId();
      const tab: Tab = {
        id: newTabId(),
        title: "Diff",
        rootNode: { type: "leaf", paneId, contentType: "diff" },
        focusedPaneId: paneId,
      };
      return {
        paneContentType: { ...state.paneContentType, [paneId]: "diff" },
        ...runLayoutCommand(state, {
          type: "new-tab",
          tab,
          panelId: ctx.panel.id,
        }).patch,
      };
    }),

  openDiffInNewPanel: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout) return state;

      // Look for an existing diff pane across ALL panels' tabs
      for (const [pId, panel] of Object.entries(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const paneId of allPaneIds(tab.rootNode)) {
            if (state.paneContentType[paneId] === "diff") {
              return {
                workspaceLayouts: {
                  ...state.workspaceLayouts,
                  [path]: {
                    ...layout,
                    activePanelId: pId,
                    panels: {
                      ...layout.panels,
                      [pId]: {
                        ...panel,
                        selectedTabId: tab.id,
                        tabs: panel.tabs.map((s) =>
                          s.id === tab.id ? { ...s, focusedPaneId: paneId } : s,
                        ),
                      },
                    },
                  },
                },
              };
            }
          }
        }
      }

      // No existing diff pane — create a new panel split with a diff tab
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { panel } = ctx;
      const newPId = newPanelId();
      const paneId = newPaneId();
      const tab: Tab = {
        id: newTabId(),
        title: "Diff",
        rootNode: { type: "leaf", paneId, contentType: "diff" },
        focusedPaneId: paneId,
      };
      const newPanelTree = insertPanelSplit(layout.panelTree, panel.id, "horizontal", newPId);
      return {
        paneContentType: { ...state.paneContentType, [paneId]: "diff" },
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            panelTree: newPanelTree,
            panels: {
              ...layout.panels,
              [newPId]: { id: newPId, tabs: [tab], selectedTabId: tab.id, pinnedTabIds: [] },
            },
            activePanelId: newPId,
          },
        },
      };
    }),

  closeTab: (tabId: string) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "close-tab",
        tabId,
        paneMetadata: activeWorkspacePaneMetadata(state),
      }).patch,
    ),

  closeOtherTabs: (tabId: string) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "close-other-tabs",
        tabId,
        paneMetadata: activeWorkspacePaneMetadata(state),
      }).patch,
    ),

  closeTabsToRight: (tabId: string) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "close-tabs-to-right",
        tabId,
        paneMetadata: activeWorkspacePaneMetadata(state),
      }).patch,
    ),

  selectTab: (tabId: string) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        selectedTabId: tabId,
      }));
    }),

  selectTabByGlobalIndex: (index: number) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;
      const tabs = globalTabList(layout);
      if (index < 0 || index >= tabs.length) return state;
      const { tabId, panelId } = tabs[index];
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            activePanelId: panelId,
            panels: {
              ...layout.panels,
              [panelId]: { ...layout.panels[panelId], selectedTabId: tabId },
            },
          },
        },
      };
    }),

  selectNextTab: () =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;
      const tabs = globalTabList(layout);
      if (tabs.length === 0) return state;
      const panel = layout.panels[layout.activePanelId];
      if (!panel) return state;
      const currentIdx = tabs.findIndex((t) => t.tabId === panel.selectedTabId);
      const nextIdx = (currentIdx + 1) % tabs.length;
      const { tabId, panelId } = tabs[nextIdx];
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            activePanelId: panelId,
            panels: {
              ...layout.panels,
              [panelId]: { ...layout.panels[panelId], selectedTabId: tabId },
            },
          },
        },
      };
    }),

  selectPrevTab: () =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;
      const tabs = globalTabList(layout);
      if (tabs.length === 0) return state;
      const panel = layout.panels[layout.activePanelId];
      if (!panel) return state;
      const currentIdx = tabs.findIndex((t) => t.tabId === panel.selectedTabId);
      const prevIdx = (currentIdx - 1 + tabs.length) % tabs.length;
      const { tabId, panelId } = tabs[prevIdx];
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            activePanelId: panelId,
            panels: {
              ...layout.panels,
              [panelId]: { ...layout.panels[panelId], selectedTabId: tabId },
            },
          },
        },
      };
    }),

  reorderTabs: (tabIds: string[]) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      return runLayoutCommand(state, {
        type: "reorder-tabs",
        panelId: ctx.panel.id,
        tabIds,
      }).patch;
    }),

  togglePinTab: (tabId: string) =>
    set(
      (state) => runLayoutCommand(state, { type: "toggle-pin-tab", tabId }).patch,
    ),

  splitPane: (direction: SplitDirection) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const tab = ctx.panel.tabs.find((t) => t.id === ctx.panel.selectedTabId);
      if (!tab) return state;
      return runLayoutCommand(state, {
        type: "split-pane",
        paneId: tab.focusedPaneId,
        direction,
        newPaneId: newPaneId(),
      }).patch;
    }),

  splitPaneAt: (
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
    opts?: {
      contentType?: "terminal" | "browser" | "diff" | "agent";
      paneCommand?: string;
      url?: string;
    },
  ) => {
    const state = get();
    const newPane = newPaneId();
    const { contentType, paneCommand, url } = opts ?? {};
    // "agent" panes are terminals that auto-run a command -- don't persist as
    // a content type.
    const treeContentType = contentType === "agent" ? undefined : contentType;
    const { patch, changed } = runLayoutCommand(state, {
      type: "split-pane-at",
      paneId: targetPaneId,
      direction,
      position,
      newPaneId: newPane,
      contentType: treeContentType,
      url,
    });
    if (!changed) return null;
    set({
      ...patch,
      ...(treeContentType && {
        paneContentType: {
          ...state.paneContentType,
          [newPane]: treeContentType,
        },
      }),
      ...(url && {
        paneUrl: {
          ...state.paneUrl,
          [newPane]: url,
        },
      }),
      ...(paneCommand && {
        pendingPaneCommands: {
          ...state.pendingPaneCommands,
          [newPane]: paneCommand,
        },
      }),
    });
    return newPane;
  },

  movePaneToTarget: (
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "move-pane",
        sourcePaneId,
        targetPaneId,
        direction,
        position,
        fallbackTab: createTab(),
      }).patch,
    ),

  moveTabToPane: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "move-tab-to-pane",
        tabId,
        targetPaneId,
        direction,
        position,
        fallbackTab: createTab(),
      }).patch,
    ),

  extractPaneToTab: (paneId: string, targetPanelId?: string) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "extract-pane-to-tab",
        paneId,
        targetPanelId,
        newTabId: newTabId(),
        fallbackTab: createTab(),
      }).patch,
    ),

  closePane: () => {
    const state = get();
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const { panel } = ctx;
    const tab = panel.tabs.find((s) => s.id === panel.selectedTabId);
    if (!tab) return;
    get().closePaneById(tab.focusedPaneId);
  },

  closePaneById: (paneId: string) => {
    const currentTitle = get().paneTitle[paneId] ?? null;
    window.electronAPI.agents
      .abandonForPane(paneId, currentTitle)
      .catch(console.error);
    set((state) =>
      runLayoutCommand(state, {
        type: "close-pane",
        paneId,
        paneMetadata: activeWorkspacePaneMetadata(state),
      }).patch,
    );
  },

  reopenClosedPane: () => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return;
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const { layout, panel } = ctx;

    const { mine } = splitClosedStack(state.closedPaneStack, path);
    const entry = mine[0];
    if (!entry) return;

    // Resolve where the restore lands from this window's viewport, so the
    // reducer never has to ask what the window is looking at: the original
    // panel if it survives, otherwise the active one.
    const targetPanelId = layout.panels[entry.panelId]
      ? entry.panelId
      : panel.id;
    const originalTab =
      entry.kind === "pane"
        ? layout.panels[targetPanelId]?.tabs.find((t) => t.id === entry.tabId)
        : undefined;

    const { patch, changed } = runLayoutCommand(state, {
      type: "reopen-closed-pane",
      newTabId: newTabId(),
      panelId: panel.id,
      ...(originalTab && { anchorPaneId: originalTab.focusedPaneId }),
    });
    if (!changed) return;

    if (entry.kind === "tab") {
      const paneContentType = { ...state.paneContentType };
      const paneCwd = { ...state.paneCwd };
      const paneUrl = { ...state.paneUrl };
      const paneTitle = { ...state.paneTitle };
      const closedPaneIds = new Set(state.closedPaneIds);
      for (const [pid, meta] of Object.entries(entry.paneMetadata)) {
        if (meta.contentType) paneContentType[pid] = meta.contentType;
        if (meta.cwd) paneCwd[pid] = meta.cwd;
        if (meta.url) paneUrl[pid] = meta.url;
        if (meta.title) paneTitle[pid] = meta.title;
        closedPaneIds.delete(pid);
      }
      set({
        ...patch,
        paneContentType,
        paneCwd,
        paneUrl,
        paneTitle,
        closedPaneIds,
      });
      return;
    }

    set({
      ...patch,
      paneContentType: {
        ...state.paneContentType,
        [entry.paneId]: entry.contentType ?? "terminal",
      },
      ...(entry.cwd && {
        paneCwd: { ...state.paneCwd, [entry.paneId]: entry.cwd },
      }),
      ...(entry.url && {
        paneUrl: { ...state.paneUrl, [entry.paneId]: entry.url },
      }),
    });
  },

  setPendingCloseConfirmPaneId: (paneId: string | null) =>
    set({ pendingCloseConfirmPaneId: paneId }),

  setPendingCloseConfirmTabId: (tabId: string | null) =>
    set({ pendingCloseConfirmTabId: tabId }),

  requestCloseTab: (tabId: string) => {
    const state = get();
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const { panel } = ctx;
    const tab = panel.tabs.find((s) => s.id === tabId);
    if (!tab) return;

    const activeStatuses = ["thinking", "working", "requires_input"];
    const hasActiveAgent = allPaneIds(tab.rootNode).some((pid) => {
      const agentState = state.paneAgentStatus[pid];
      return agentState && activeStatuses.includes(agentState.status);
    });

    if (hasActiveAgent) {
      set({ pendingCloseConfirmTabId: tabId });
    } else {
      get().closeTab(tabId);
    }
  },

  requestClosePane: () => {
    const state = get();
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const { panel } = ctx;
    const tab = panel.tabs.find((s) => s.id === panel.selectedTabId);
    if (!tab) return;
    const focusedPaneId = tab.focusedPaneId;
    get().requestClosePaneById(focusedPaneId);
  },

  requestClosePaneById: (paneId: string) => {
    const state = get();
    const agentState = state.paneAgentStatus[paneId];
    const activeStatuses = ["thinking", "working", "requires_input"];
    if (agentState && activeStatuses.includes(agentState.status)) {
      set({ pendingCloseConfirmPaneId: paneId });
    } else {
      get().closePaneById(paneId);
    }
  },

  focusPane: (paneId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout) return state;

      // Search all panels for the pane, not just the active one
      for (const [panelId, panel] of Object.entries(layout.panels)) {
        const tab = panel.tabs.find((t) => hasPaneId(t.rootNode, paneId));
        if (tab) {
          return {
            workspaceLayouts: {
              ...state.workspaceLayouts,
              [path]: {
                ...layout,
                activePanelId: panelId,
                panels: {
                  ...layout.panels,
                  [panelId]: {
                    ...panel,
                    selectedTabId: tab.id,
                    tabs: panel.tabs.map((s) =>
                      s.id === tab.id ? { ...s, focusedPaneId: paneId } : s,
                    ),
                  },
                },
              },
            },
          };
        }
      }
      return state;
    }),

  focusNextPane: () =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const tab = panel.tabs.find((s) => s.id === panel.selectedTabId);
      if (!tab) return state;
      const next = nextPaneId(tab.rootNode, tab.focusedPaneId);
      if (!next) return state;
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        tabs: p.tabs.map((s) =>
          s.id === tab.id ? { ...s, focusedPaneId: next } : s,
        ),
      }));
    }),

  focusPrevPane: () =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const tab = panel.tabs.find((s) => s.id === panel.selectedTabId);
      if (!tab) return state;
      const prev = prevPaneId(tab.rootNode, tab.focusedPaneId);
      if (!prev) return state;
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        tabs: p.tabs.map((s) =>
          s.id === tab.id ? { ...s, focusedPaneId: prev } : s,
        ),
      }));
    }),

  // Which pane is focused does not change — only the demand that it actually
  // hold the keyboard. The nonce is the whole message; the pane's auto-focus
  // effect listens for the bump (ADR-172).
  refocusActivePane: () =>
    set((state) => ({ paneFocusNonce: state.paneFocusNonce + 1 })),

  setPaneCwd: (paneId: string, cwd: string) =>
    set((state) => {
      if (state.paneCwd[paneId] === cwd) return state;
      return { paneCwd: { ...state.paneCwd, [paneId]: cwd } };
    }),

  setPaneTitle: (paneId: string, title: string) =>
    set((state) => {
      if (state.paneTitle[paneId] === title) return state;
      return { paneTitle: { ...state.paneTitle, [paneId]: title } };
    }),

  clearPaneTitle: (paneId: string) =>
    set((state) => {
      if (!(paneId in state.paneTitle)) return state;
      const { [paneId]: _, ...rest } = state.paneTitle;
      return { paneTitle: rest };
    }),

  setPaneFavicon: (paneId: string, favicon: string | null) =>
    set((state) => {
      if (favicon) {
        if (state.paneFavicon[paneId] === favicon) return state;
        return { paneFavicon: { ...state.paneFavicon, [paneId]: favicon } };
      }
      if (!(paneId in state.paneFavicon)) return state;
      const { [paneId]: _, ...rest } = state.paneFavicon;
      return { paneFavicon: rest };
    }),

  setPaneAudioPlaying: (paneId: string, playing: boolean) =>
    set((state) => {
      if (playing) {
        if (state.paneAudioPlaying[paneId] === true) return state;
        return { paneAudioPlaying: { ...state.paneAudioPlaying, [paneId]: true } };
      }
      if (!(paneId in state.paneAudioPlaying)) return state;
      const { [paneId]: _, ...rest } = state.paneAudioPlaying;
      return { paneAudioPlaying: rest };
    }),

  setPaneAudioMuted: (paneId: string, muted: boolean) =>
    set((state) => {
      if (muted) {
        if (state.paneAudioMuted[paneId] === true) return state;
        return { paneAudioMuted: { ...state.paneAudioMuted, [paneId]: true } };
      }
      if (!(paneId in state.paneAudioMuted)) return state;
      const { [paneId]: _, ...rest } = state.paneAudioMuted;
      return { paneAudioMuted: rest };
    }),

  setPaneRecordingStartedAt: (paneId: string, startedAt: number | null) =>
    set((state) => {
      if (startedAt !== null) {
        if (state.paneRecordingStartedAt[paneId] === startedAt) return state;
        return {
          paneRecordingStartedAt: {
            ...state.paneRecordingStartedAt,
            [paneId]: startedAt,
          },
        };
      }
      if (!(paneId in state.paneRecordingStartedAt)) return state;
      const { [paneId]: _, ...rest } = state.paneRecordingStartedAt;
      return { paneRecordingStartedAt: rest };
    }),

  setPaneUrl: (paneId: string, url: string) =>
    set((state) => {
      if (state.paneUrl[paneId] === url) return state;
      // Update the paneUrl map
      const newState: Partial<AppState> = {
        paneUrl: { ...state.paneUrl, [paneId]: url },
      };
      // Also update the url in the rootNode leaf so it persists
      const ctx = getActivePanelContext(state);
      if (ctx) {
        const { path, layout, panel } = ctx;
        const updatedTabs = panel.tabs.map((s) => {
          const newRoot = updateLeafUrl(s.rootNode, paneId, url);
          return newRoot === s.rootNode ? s : { ...s, rootNode: newRoot };
        });
        if (updatedTabs.some((t, i) => t !== panel.tabs[i])) {
          Object.assign(newState, updatePanel(state, path, layout, panel.id, (p) => ({
            ...p,
            tabs: updatedTabs,
          })));
        }
      }
      return newState;
    }),

  setPaneContentType: (
    paneId: string,
    contentType: "terminal" | "browser" | "diff",
  ) =>
    set((state) => {
      const current = state.paneContentType[paneId];
      if (current === contentType) return state;
      // For "terminal", remove the key (terminal is the default/implicit type)
      const newContentType = { ...state.paneContentType };
      if (contentType === "terminal") {
        delete newContentType[paneId];
      } else {
        newContentType[paneId] = contentType;
      }
      return {
        paneContentType: newContentType,
        // The tree's leaf carries the type too, so it survives a reload.
        ...runLayoutCommand(state, {
          type: "set-pane-content-type",
          paneId,
          contentType,
        }).patch,
      };
    }),

  setWebviewFocused: (paneId: string, focused: boolean) =>
    set((state) => {
      if (focused) return { webviewFocusedPaneId: paneId };
      // Only the pane that owns the focus may clear it — a blur from some other
      // browser pane must not wipe the active one's badge.
      return state.webviewFocusedPaneId === paneId
        ? { webviewFocusedPaneId: null }
        : {};
    }),

  setPaneAgentStatus: (paneId: string, agent: AgentState) =>
    set((state) => {
      const current = state.paneAgentStatus[paneId];
      if (
        current &&
        current.status === agent.status &&
        current.kind === agent.kind &&
        current.since === agent.since &&
        current.title === agent.title &&
        current.processName === agent.processName
      )
        return state;
      // Remove from store only when agent is truly gone (kind is null)
      if (agent.status === "idle" && agent.kind === null) {
        console.debug(`[agent-status] store: pane=${paneId} → REMOVED (gone)`);
        const { [paneId]: _, ...rest } = state.paneAgentStatus;
        return { paneAgentStatus: rest };
      }
      console.debug(
        `[agent-status] store: pane=${paneId} → ${agent.kind}/${agent.status} (title=${agent.title})`,
      );
      return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: agent } };
    }),

  setPendingStartupCommand: (workspacePath: string, command: string) =>
    set((state) => ({
      pendingStartupCommands: {
        ...state.pendingStartupCommands,
        [workspacePath]: command,
      },
    })),

  consumePendingStartupCommand: (workspacePath: string) => {
    const cmd = get().pendingStartupCommands[workspacePath] ?? null;
    if (cmd) {
      set((state) => {
        const { [workspacePath]: _, ...rest } = state.pendingStartupCommands;
        return { pendingStartupCommands: rest };
      });
    }
    return cmd;
  },

  consumePendingPaneCommand: (paneId: string) => {
    const cmd = get().pendingPaneCommands[paneId] ?? null;
    if (cmd) {
      set((state) => {
        const { [paneId]: _, ...rest } = state.pendingPaneCommands;
        return { pendingPaneCommands: rest };
      });
    }
    return cmd;
  },

  removeWorkspaceLayout: (workspacePath: string) =>
    set((state) => {
      const layout = state.workspaceLayouts[workspacePath];
      if (!layout) {
        const { [workspacePath]: _, ...rest } = state.workspaceLayouts;
        return { workspaceLayouts: rest };
      }

      // Mark all panes across all panels as closed so terminals get killed
      const newClosedPaneIds = new Set(state.closedPaneIds);
      const deadPaneIds: string[] = [];
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          for (const pid of allPaneIds(tab.rootNode)) {
            newClosedPaneIds.add(pid);
            deadPaneIds.push(pid);
          }
        }
      }

      // Clean up metadata
      const newCwd = { ...state.paneCwd };
      const newTitle = { ...state.paneTitle };
      const newAgentStatus = { ...state.paneAgentStatus };
      const newContentType = { ...state.paneContentType };
      const newPaneUrl = { ...state.paneUrl };
      for (const pid of deadPaneIds) {
        delete newCwd[pid];
        delete newTitle[pid];
        delete newAgentStatus[pid];
        delete newContentType[pid];
        delete newPaneUrl[pid];
      }

      const { [workspacePath]: _, ...rest } = state.workspaceLayouts;
      return {
        closedPaneIds: newClosedPaneIds,
        workspaceLayouts: rest,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneUrl: newPaneUrl,
      };
    }),

  // ── Panel operations ──

  splitPanel: (direction: SplitDirection) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      return runLayoutCommand(state, {
        type: "split-panel",
        panelId: ctx.panel.id,
        direction,
        newPanelId: newPanelId(),
        // The selected tab moves into the new panel; if that empties the
        // source panel, it gets a fresh terminal rather than nothing.
        tabId: ctx.panel.selectedTabId,
        fallbackTab: createTab(),
      }).patch;
    }),

  closePanel: (panelId: string) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "close-panel",
        panelId,
        fallbackPanelId: newPanelId(),
      }).patch,
    ),

  focusPanel: (panelId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout || !layout.panels[panelId]) return state;
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: { ...layout, activePanelId: panelId },
        },
      };
    }),

  focusNextPanel: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout) return state;
      const next = nextPanelId(layout.panelTree, layout.activePanelId);
      if (!next) return state;
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: { ...layout, activePanelId: next },
        },
      };
    }),

  focusPrevPanel: () =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout) return state;
      const prev = prevPanelId(layout.panelTree, layout.activePanelId);
      if (!prev) return state;
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: { ...layout, activePanelId: prev },
        },
      };
    }),

  updatePanelSplitRatio: (firstPanelId: string, ratio: number) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "update-panel-ratio",
        firstPanelId,
        ratio,
      }).patch,
    ),

  moveTabToPanel: (tabId: string, targetPanelId: string) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "move-tab-to-panel",
        tabId,
        targetPanelId,
      }).patch,
    ),

  splitPanelWithTab: (tabId: string, targetPanelId: string, direction: SplitDirection) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "split-panel-with-tab",
        tabId,
        targetPanelId,
        direction,
        newPanelId: newPanelId(),
        fallbackTab: createTab(),
      }).patch,
    ),

  mergeTabIntoTab: (sourceTabId: string, targetTabId: string) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;
      if (sourceTabId === targetTabId) return state;

      const src = findPanelWithTab(layout, sourceTabId);
      const tgt = findPanelWithTab(layout, targetTabId);
      if (!src || !tgt) return state;
      const { panel: sourcePanel, tab: sourceTab } = src;
      const { panel: targetPanel, tab: targetTab } = tgt;

      // Merge source pane tree into target as a horizontal split
      const newTargetRoot: PaneNode = {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: targetTab.rootNode,
        second: sourceTab.rootNode,
      };
      const focusPaneId = allPaneIds(sourceTab.rootNode)[0];

      // Same panel
      if (sourcePanel.id === targetPanel.id) {
        const newTabs = sourcePanel.tabs
          .filter((t) => t.id !== sourceTabId)
          .map((t) => t.id === targetTabId ? { ...t, rootNode: newTargetRoot, focusedPaneId: focusPaneId } : t);
        return updatePanel(state, path, layout, sourcePanel.id, (p) => ({
          ...p,
          tabs: newTabs,
          selectedTabId: targetTabId,
          pinnedTabIds: (p.pinnedTabIds ?? []).filter((id) => id !== sourceTabId),
        }));
      }

      // Cross-panel
      const newPanels = { ...layout.panels };
      let newPanelTree = layout.panelTree;

      newPanels[targetPanel.id] = {
        ...targetPanel,
        tabs: targetPanel.tabs.map((t) =>
          t.id === targetTabId ? { ...t, rootNode: newTargetRoot, focusedPaneId: focusPaneId } : t,
        ),
        selectedTabId: targetTabId,
      };

      const remainingTabs = sourcePanel.tabs.filter((t) => t.id !== sourceTabId);
      if (remainingTabs.length === 0 && Object.keys(newPanels).length > 1) {
        const pruned = removePanelFromTree(newPanelTree, sourcePanel.id);
        if (pruned) newPanelTree = pruned;
        delete newPanels[sourcePanel.id];
      } else if (remainingTabs.length === 0) {
        const fresh = createTab();
        newPanels[sourcePanel.id] = { ...sourcePanel, tabs: [fresh], selectedTabId: fresh.id, pinnedTabIds: [] };
      } else {
        newPanels[sourcePanel.id] = {
          ...sourcePanel,
          tabs: remainingTabs,
          selectedTabId: sourcePanel.selectedTabId === sourceTabId ? remainingTabs[0].id : sourcePanel.selectedTabId,
          pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter((id) => id !== sourceTabId),
        };
      }

      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: { ...layout, panelTree: newPanelTree, panels: newPanels, activePanelId: targetPanel.id },
        },
      };
    }),

  updateSplitRatio: (firstPaneId: string, ratio: number) =>
    set((state) =>
      runLayoutCommand(state, {
        type: "update-split-ratio",
        firstPaneId,
        ratio,
      }).patch,
    ),

  setPickedElement: (paneId: string, result: PickedElementResult) =>
    set((state) => ({
      panePickedElement: { ...state.panePickedElement, [paneId]: result },
    })),

  clearPickedElement: (paneId: string) =>
    set((state) => {
      const { [paneId]: _, ...rest } = state.panePickedElement;
      return { panePickedElement: rest };
    }),

  initWorktreeSetup: (
    wsPathHint: string,
    hasStartScript: boolean,
    startScript?: string | null,
  ) =>
    set((state) => {
      const baseSteps: SetupStep[] = [
        "prune",
        "fetch",
        "create-worktree",
        "persist",
        "switch",
      ];
      if (hasStartScript) baseSteps.push("setup-script");
      const steps = baseSteps.map((step) => ({
        step,
        status: "pending" as StepStatus,
      }));
      return {
        worktreeSetupState: {
          ...state.worktreeSetupState,
          [wsPathHint]: {
            steps,
            completed: false,
            startScript: startScript ?? null,
            workspacePath: wsPathHint,
          },
        },
      };
    }),

  updateWorktreeSetupStep: (
    wsPath: string,
    step: SetupStep,
    status: StepStatus,
    message?: string,
  ) =>
    set((state) => {
      const entry = state.worktreeSetupState[wsPath];
      if (!entry) return state;
      return {
        worktreeSetupState: {
          ...state.worktreeSetupState,
          [wsPath]: {
            ...entry,
            steps: entry.steps.map((s) =>
              s.step === step
                ? {
                    ...s,
                    status,
                    ...(message !== undefined ? { message } : {}),
                  }
                : s,
            ),
          },
        },
      };
    }),

  completeWorktreeSetup: (wsPath: string) =>
    set((state) => {
      const entry = state.worktreeSetupState[wsPath];
      if (!entry) return state;
      return {
        worktreeSetupState: {
          ...state.worktreeSetupState,
          [wsPath]: { ...entry, completed: true },
        },
      };
    }),

  clearWorktreeSetup: (wsPath: string) =>
    set((state) => {
      const { [wsPath]: _, ...rest } = state.worktreeSetupState;
      return { worktreeSetupState: rest };
    }),

  migrateWorktreeSetupPath: (fromKey: string, toKey: string) =>
    set((state) => {
      const entry = state.worktreeSetupState[fromKey];
      if (!entry) return state;
      const { [fromKey]: _, ...rest } = state.worktreeSetupState;
      return {
        worktreeSetupState: {
          ...rest,
          [toKey]: { ...entry, workspacePath: toKey },
        },
      };
    }),

  // ── Multi-window detach / reattach (ADR-156) ──

  serializeTabForDetach: (tabId: string): DetachedTabPayload => {
    const state = get();

    // The tab may live in any workspace layout, not just the active one.
    let foundTab: Tab | null = null;
    for (const layout of Object.values(state.workspaceLayouts)) {
      const res = findPanelWithTab(layout, tabId);
      if (res) {
        foundTab = res.tab;
        break;
      }
    }
    if (!foundTab) {
      throw new Error(`serializeTabForDetach: tab ${tabId} not found`);
    }

    const paneIds = allPaneIds(foundTab.rootNode);
    const paneState: DetachedTabPayload["paneState"] = {
      cwd: {},
      title: {},
      contentType: {},
      url: {},
      favicon: {},
      agentStatus: {},
      audioPlaying: {},
      audioMuted: {},
      pickedElement: {},
    };
    for (const pid of paneIds) {
      if (state.paneCwd[pid] !== undefined) paneState.cwd[pid] = state.paneCwd[pid];
      if (state.paneTitle[pid] !== undefined) paneState.title[pid] = state.paneTitle[pid];
      if (state.paneContentType[pid] !== undefined) paneState.contentType[pid] = state.paneContentType[pid];
      if (state.paneUrl[pid] !== undefined) paneState.url[pid] = state.paneUrl[pid];
      if (state.paneFavicon[pid] !== undefined) paneState.favicon[pid] = state.paneFavicon[pid];
      if (state.paneAgentStatus[pid] !== undefined) paneState.agentStatus[pid] = state.paneAgentStatus[pid];
      if (state.paneAudioPlaying[pid] !== undefined) paneState.audioPlaying[pid] = state.paneAudioPlaying[pid];
      if (state.paneAudioMuted[pid] !== undefined) paneState.audioMuted[pid] = state.paneAudioMuted[pid];
      if (state.panePickedElement[pid] !== undefined) paneState.pickedElement[pid] = state.panePickedElement[pid];
    }

    // Resolve the theme the tab is currently painted with — its owning
    // project's override (or null = global). The detached window applies this so
    // it matches the workspace instead of falling back to the global theme.
    const sourceWorkspacePath = state.activeWorkspacePath ?? "";
    const themeName = isHomePath(sourceWorkspacePath)
      ? null
      : useProjectStore
          .getState()
          .projects.find((p) =>
            p.workspaces.some((w) => w.path === sourceWorkspacePath),
          )?.themeName ?? null;

    const payload: DetachedTabPayload = {
      tab: {
        id: foundTab.id,
        title: foundTab.title,
        rootNode: foundTab.rootNode,
        focusedPaneId: foundTab.focusedPaneId,
      },
      paneState,
      sourceWorkspacePath,
      themeName,
    };

    // Deep-copy so no live store references (rootNode, side-map objects) leak
    // across the IPC boundary; guarantees a plain, structured-clone-safe value.
    return structuredClone(payload);
  },

  removeDetachedTabLocally: (tabId: string) => {
    const state = get();
    const ctx = getActiveLayoutContext(state);
    if (!ctx) return;
    const found = findPanelWithTab(ctx.layout, tabId);
    if (!found) return;
    const paneIds = allPaneIds(found.tab.rootNode);

    // Release each pane's backend WITHOUT terminating it, so it can re-attach in
    // the destination window. (closeTab, by contrast, kills these sessions.)
    for (const pid of paneIds) {
      const contentType = state.paneContentType[pid];
      if (contentType === "browser") {
        window.electronAPI.webview.unregister(pid);
      } else if (contentType === "diff") {
        // Diff panes have no backend session to release.
      } else {
        // Terminal (default): detach releases the daemon session, keeping it alive.
        window.electronAPI.pty.detach(pid);
      }
    }

    set((s) => {
      const currentCtx = getActiveLayoutContext(s);
      if (!currentCtx) return s;
      const { path, layout } = currentCtx;
      const currentFound = findPanelWithTab(layout, tabId);
      if (!currentFound) return s;
      const { panel } = currentFound;

      const idx = panel.tabs.findIndex((t) => t.id === tabId);
      const newTabs = panel.tabs.filter((t) => t.id !== tabId);
      const newSelected =
        newTabs.length === 0
          ? ""
          : tabId === panel.selectedTabId
            ? newTabs[Math.min(idx, newTabs.length - 1)].id
            : panel.selectedTabId;

      // Drop the tab's entries from every per-pane side-map.
      const newCwd = { ...s.paneCwd };
      const newTitle = { ...s.paneTitle };
      const newAgentStatus = { ...s.paneAgentStatus };
      const newContentType = { ...s.paneContentType };
      const newFavicon = { ...s.paneFavicon };
      const newAudioPlaying = { ...s.paneAudioPlaying };
      const newAudioMuted = { ...s.paneAudioMuted };
      const newPaneUrl = { ...s.paneUrl };
      const newPickedElement = { ...s.panePickedElement };
      const newPendingCommands = { ...s.pendingPaneCommands };
      for (const pid of paneIds) {
        delete newCwd[pid];
        delete newTitle[pid];
        delete newAgentStatus[pid];
        delete newContentType[pid];
        delete newFavicon[pid];
        delete newAudioPlaying[pid];
        delete newAudioMuted[pid];
        delete newPaneUrl[pid];
        delete newPickedElement[pid];
        delete newPendingCommands[pid];
      }

      const sideMaps = {
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneFavicon: newFavicon,
        paneAudioPlaying: newAudioPlaying,
        paneAudioMuted: newAudioMuted,
        paneUrl: newPaneUrl,
        panePickedElement: newPickedElement,
        pendingPaneCommands: newPendingCommands,
      };

      // Collapse an emptied panel exactly the way closeTab does.
      const willRemovePanel =
        newTabs.length === 0 && Object.keys(layout.panels).length > 1;
      if (willRemovePanel) {
        const newPanelTree = removePanelFromTree(layout.panelTree, panel.id);
        const { [panel.id]: _, ...remainingPanels } = layout.panels;
        const remainingIds = Object.keys(remainingPanels);
        const newActivePanelId = remainingIds.includes(layout.activePanelId)
          ? layout.activePanelId
          : remainingIds[0];
        return {
          ...sideMaps,
          workspaceLayouts: {
            ...s.workspaceLayouts,
            [path]: {
              ...layout,
              panelTree: newPanelTree ?? layout.panelTree,
              panels: remainingPanels,
              activePanelId: newActivePanelId,
            },
          },
        };
      }

      return {
        ...sideMaps,
        ...updatePanel(s, path, layout, panel.id, (p) => ({
          ...p,
          tabs: newTabs,
          selectedTabId: newSelected,
          pinnedTabIds: (p.pinnedTabIds ?? []).filter((id) => id !== tabId),
        })),
      };
    });
  },

  serializePaneForDetach: (paneId: string): DetachedTabPayload => {
    const state = get();

    // The pane may live in any workspace layout, not just the active one.
    let foundTab: Tab | null = null;
    for (const layout of Object.values(state.workspaceLayouts)) {
      const res = findPanelWithPane(layout, paneId);
      if (res) {
        foundTab = res.tab;
        break;
      }
    }
    if (!foundTab) {
      throw new Error(`serializePaneForDetach: pane ${paneId} not found`);
    }

    // A detached pane is a single-leaf tab; copy only this pane's side-map
    // entries into the payload.
    const paneState: DetachedTabPayload["paneState"] = {
      cwd: {},
      title: {},
      contentType: {},
      url: {},
      favicon: {},
      agentStatus: {},
      audioPlaying: {},
      audioMuted: {},
      pickedElement: {},
    };
    if (state.paneCwd[paneId] !== undefined) paneState.cwd[paneId] = state.paneCwd[paneId];
    if (state.paneTitle[paneId] !== undefined) paneState.title[paneId] = state.paneTitle[paneId];
    if (state.paneContentType[paneId] !== undefined) paneState.contentType[paneId] = state.paneContentType[paneId];
    if (state.paneUrl[paneId] !== undefined) paneState.url[paneId] = state.paneUrl[paneId];
    if (state.paneFavicon[paneId] !== undefined) paneState.favicon[paneId] = state.paneFavicon[paneId];
    if (state.paneAgentStatus[paneId] !== undefined) paneState.agentStatus[paneId] = state.paneAgentStatus[paneId];
    if (state.paneAudioPlaying[paneId] !== undefined) paneState.audioPlaying[paneId] = state.paneAudioPlaying[paneId];
    if (state.paneAudioMuted[paneId] !== undefined) paneState.audioMuted[paneId] = state.paneAudioMuted[paneId];
    if (state.panePickedElement[paneId] !== undefined) paneState.pickedElement[paneId] = state.panePickedElement[paneId];

    // Resolve the theme/workspace exactly as serializeTabForDetach does.
    const sourceWorkspacePath = state.activeWorkspacePath ?? "";
    const themeName = isHomePath(sourceWorkspacePath)
      ? null
      : useProjectStore
          .getState()
          .projects.find((p) =>
            p.workspaces.some((w) => w.path === sourceWorkspacePath),
          )?.themeName ?? null;

    const payload: DetachedTabPayload = {
      tab: {
        id: newTabId(),
        title: "Terminal",
        rootNode: { type: "leaf", paneId },
        focusedPaneId: paneId,
      },
      paneState,
      sourceWorkspacePath,
      themeName,
    };

    // Deep-copy so no live store references leak across the IPC boundary.
    return structuredClone(payload);
  },

  removeDetachedPaneLocally: (paneId: string) => {
    const state = get();
    const ctx = getActiveLayoutContext(state);
    if (!ctx) return;
    const found = findPanelWithPane(ctx.layout, paneId);
    if (!found) return;

    // Release this pane's backend WITHOUT terminating it, so it can re-attach in
    // the destination window.
    const contentType = state.paneContentType[paneId];
    if (contentType === "browser") {
      window.electronAPI.webview.unregister(paneId);
    } else if (contentType === "diff") {
      // Diff panes have no backend session to release.
    } else {
      // Terminal (default): detach releases the daemon session, keeping it alive.
      window.electronAPI.pty.detach(paneId);
    }

    set((s) => {
      const currentCtx = getActiveLayoutContext(s);
      if (!currentCtx) return s;
      const { path, layout } = currentCtx;
      const currentFound = findPanelWithPane(layout, paneId);
      if (!currentFound) return s;
      const { panel, tab } = currentFound;

      const remaining = removePane(tab.rootNode, paneId);

      // Pane was one of several — collapse the split and keep the tab.
      if (remaining) {
        const ids = allPaneIds(remaining);
        const newFocused =
          tab.focusedPaneId === paneId ? ids[0] : tab.focusedPaneId;
        return updatePanel(s, path, layout, panel.id, (p) => ({
          ...p,
          tabs: p.tabs.map((t) =>
            t.id === tab.id
              ? { ...t, rootNode: remaining, focusedPaneId: newFocused }
              : t,
          ),
        }));
      }

      // Pane was the tab's sole leaf — remove the whole tab exactly as
      // removeDetachedTabLocally does, and drop this pane's side-map entries.
      const idx = panel.tabs.findIndex((t) => t.id === tab.id);
      const newTabs = panel.tabs.filter((t) => t.id !== tab.id);
      const newSelected =
        newTabs.length === 0
          ? ""
          : tab.id === panel.selectedTabId
            ? newTabs[Math.min(idx, newTabs.length - 1)].id
            : panel.selectedTabId;

      const newCwd = { ...s.paneCwd };
      const newTitle = { ...s.paneTitle };
      const newAgentStatus = { ...s.paneAgentStatus };
      const newContentType = { ...s.paneContentType };
      const newFavicon = { ...s.paneFavicon };
      const newAudioPlaying = { ...s.paneAudioPlaying };
      const newAudioMuted = { ...s.paneAudioMuted };
      const newPaneUrl = { ...s.paneUrl };
      const newPickedElement = { ...s.panePickedElement };
      const newPendingCommands = { ...s.pendingPaneCommands };
      delete newCwd[paneId];
      delete newTitle[paneId];
      delete newAgentStatus[paneId];
      delete newContentType[paneId];
      delete newFavicon[paneId];
      delete newAudioPlaying[paneId];
      delete newAudioMuted[paneId];
      delete newPaneUrl[paneId];
      delete newPickedElement[paneId];
      delete newPendingCommands[paneId];

      const sideMaps = {
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneFavicon: newFavicon,
        paneAudioPlaying: newAudioPlaying,
        paneAudioMuted: newAudioMuted,
        paneUrl: newPaneUrl,
        panePickedElement: newPickedElement,
        pendingPaneCommands: newPendingCommands,
      };

      // Collapse an emptied panel exactly the way removeDetachedTabLocally does.
      const willRemovePanel =
        newTabs.length === 0 && Object.keys(layout.panels).length > 1;
      if (willRemovePanel) {
        const newPanelTree = removePanelFromTree(layout.panelTree, panel.id);
        const { [panel.id]: _, ...remainingPanels } = layout.panels;
        const remainingIds = Object.keys(remainingPanels);
        const newActivePanelId = remainingIds.includes(layout.activePanelId)
          ? layout.activePanelId
          : remainingIds[0];
        return {
          ...sideMaps,
          workspaceLayouts: {
            ...s.workspaceLayouts,
            [path]: {
              ...layout,
              panelTree: newPanelTree ?? layout.panelTree,
              panels: remainingPanels,
              activePanelId: newActivePanelId,
            },
          },
        };
      }

      return {
        ...sideMaps,
        ...updatePanel(s, path, layout, panel.id, (p) => ({
          ...p,
          tabs: newTabs,
          selectedTabId: newSelected,
          pinnedTabIds: (p.pinnedTabIds ?? []).filter((id) => id !== tab.id),
        })),
      };
    });
  },

  hydrateDetachedTab: (payload: DetachedTabPayload) =>
    set((state) => {
      const tab: Tab = {
        id: payload.tab.id,
        title: payload.tab.title,
        rootNode: payload.tab.rootNode,
        focusedPaneId: payload.tab.focusedPaneId,
      };
      const layout = createSinglePanelLayout(newPanelId(), [tab], tab.id, []);
      const key = payload.sourceWorkspacePath;
      const ps = payload.paneState;

      // Side-map value types are non-null; skip any null entries when merging.
      const mergeDefined = <T>(
        base: Record<string, T>,
        src: Record<string, T | null>,
      ): Record<string, T> => {
        const out = { ...base };
        for (const [pid, value] of Object.entries(src)) {
          if (value !== null && value !== undefined) out[pid] = value;
        }
        return out;
      };

      return {
        workspaceLayouts: { ...state.workspaceLayouts, [key]: layout },
        activeWorkspacePath: key,
        layoutLoaded: true,
        paneCwd: mergeDefined(state.paneCwd, ps.cwd),
        paneTitle: mergeDefined(state.paneTitle, ps.title),
        paneContentType: { ...state.paneContentType, ...ps.contentType },
        paneUrl: mergeDefined(state.paneUrl, ps.url),
        paneFavicon: mergeDefined(state.paneFavicon, ps.favicon),
        paneAgentStatus: mergeDefined(state.paneAgentStatus, ps.agentStatus),
        paneAudioPlaying: { ...state.paneAudioPlaying, ...ps.audioPlaying },
        paneAudioMuted: { ...state.paneAudioMuted, ...ps.audioMuted },
        panePickedElement: mergeDefined(state.panePickedElement, ps.pickedElement),
      };
    }),

  receiveReattachedTab: (payload: DetachedTabPayload) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;

      const targetPanel = layout.panels[layout.activePanelId];
      if (!targetPanel) return state;

      const tab: Tab = {
        id: payload.tab.id,
        title: payload.tab.title,
        rootNode: payload.tab.rootNode,
        focusedPaneId: payload.tab.focusedPaneId,
      };

      // Insert into the active panel the same way moveTabToPanel does: append to
      // the panel's tabs and select the reattached tab.
      const targetTabs = [...targetPanel.tabs, tab];
      const ps = payload.paneState;

      // Side-map value types are non-null; skip any null entries when merging.
      const mergeDefined = <T>(
        base: Record<string, T>,
        src: Record<string, T | null>,
      ): Record<string, T> => {
        const out = { ...base };
        for (const [pid, value] of Object.entries(src)) {
          if (value !== null && value !== undefined) out[pid] = value;
        }
        return out;
      };

      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            panels: {
              ...layout.panels,
              [layout.activePanelId]: {
                ...targetPanel,
                tabs: targetTabs,
                selectedTabId: tab.id,
              },
            },
          },
        },
        paneCwd: mergeDefined(state.paneCwd, ps.cwd),
        paneTitle: mergeDefined(state.paneTitle, ps.title),
        paneContentType: { ...state.paneContentType, ...ps.contentType },
        paneUrl: mergeDefined(state.paneUrl, ps.url),
        paneFavicon: mergeDefined(state.paneFavicon, ps.favicon),
        paneAgentStatus: mergeDefined(state.paneAgentStatus, ps.agentStatus),
        paneAudioPlaying: { ...state.paneAudioPlaying, ...ps.audioPlaying },
        paneAudioMuted: { ...state.paneAudioMuted, ...ps.audioMuted },
        panePickedElement: mergeDefined(state.panePickedElement, ps.pickedElement),
      };
    }),
}));

// ── Layout Persistence ──

let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

/** Immediately persist the active workspace's layout to disk. */
function flushLayoutSave(): void {
  const state = useAppStore.getState();
  const wsPath = state.activeWorkspacePath;
  if (!wsPath) return;
  const layout = state.workspaceLayouts[wsPath];
  if (!layout) return;

  // Serialize all panels in the layout
  const persistedPanels: Record<string, PersistedPanel> = {};
  for (const [panelId, panel] of Object.entries(layout.panels)) {
    persistedPanels[panelId] = {
      id: panelId,
      tabs: panel.tabs.map((tab) => {
        const paneIds = allPaneIds(tab.rootNode);
        const paneSessions: Record<
          string,
          {
            daemonSessionId: string;
            lastCwd: string | null;
            lastTitle: string | null;
            lastAgentStatus?: AgentState | null;
          }
        > = {};
        for (const pid of paneIds) {
          paneSessions[pid] = {
            daemonSessionId: pid,
            lastCwd: state.paneCwd[pid] ?? null,
            lastTitle: state.paneTitle[pid] ?? null,
            lastAgentStatus: state.paneAgentStatus[pid] ?? null,
          };
        }
        return {
          id: tab.id,
          title: tab.title,
          rootNode: tab.rootNode,
          focusedPaneId: tab.focusedPaneId,
          paneSessions,
        } satisfies PersistedTab;
      }),
      selectedTabId: panel.selectedTabId,
      pinnedTabIds: panel.pinnedTabIds,
    };
  }

  const persisted: PersistedWorkspace = {
    workspacePath: wsPath,
    panelTree: layout.panelTree,
    panels: persistedPanels,
    activePanelId: layout.activePanelId,
  };

  window.electronAPI?.layout.save(persisted)?.catch(handleLayoutSaveRejection);
}

/**
 * The web app can't persist a layout yet (ADR-178, slice 2 owns that). The
 * bridge refuses every `layout.save` with the same `BridgeUnavailableError`,
 * and this fires on every debounced save — so the shared once-per-session
 * toast (`src/lib/bridge-unavailable-toast.ts`) lets only the first one
 * reach the user; every save after that stays silent. The local mutation
 * already happened before this was ever called; only the write to disk is
 * refused. A thin wrapper rather than a direct `.catch(handleBridgeUnavailable(...))`
 * because a real save failure here is logged, not rethrown — this runs off a
 * debounce timer with nothing above it to catch a throw.
 */
export function handleLayoutSaveRejection(err: unknown): void {
  if (!(err instanceof BridgeUnavailableError)) {
    console.error("[layout] failed to save layout:", err);
    return;
  }
  showBridgeUnavailableToastOnce(
    "layout-save-unavailable",
    "Layout changes aren't saved from the browser yet",
  );
}

/** Debounced save of the active workspace's layout to disk */
function saveActiveWorkspaceLayout(): void {
  if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => {
    saveLayoutTimer = null;
    flushLayoutSave();
  }, 500);
}

// Subscribe to store changes and auto-save layout.
//
// Detached windows (ADR-156) are ephemeral and MUST NOT persist their layout —
// they share a `workspacePath` with the primary window, so saving would clobber
// the primary's persisted state. Gate the whole subscription on detached mode.
useAppStore.subscribe((state, prevState) => {
  if (window.electronAPI?.isDetached) return;
  if (
    state.workspaceLayouts !== prevState.workspaceLayouts ||
    state.activeWorkspacePath !== prevState.activeWorkspacePath ||
    state.paneAgentStatus !== prevState.paneAgentStatus
  ) {
    saveActiveWorkspaceLayout();
  }
});

// Flush any pending layout save before the window unloads (app quit / reload)
// so that recently-created panes (e.g. diff, browser) are never lost. Detached
// windows never save, so this flush is a no-op for them.
window.addEventListener("beforeunload", () => {
  if (window.electronAPI?.isDetached) return;
  if (saveLayoutTimer) {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = null;
    flushLayoutSave();
  }
});
