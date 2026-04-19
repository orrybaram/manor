import { create } from "zustand";
import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  hasPaneId,
  insertSplit,
  insertSplitAt,
  movePane,
  insertSubtreeAt,
  removePane,
  nextPaneId,
  prevPaneId,
  updateLeafContentType,
  updateRatio,
} from "./pane-tree";
import {
  type PanelNode,
  allPanelIds,
  insertPanelSplit,
  removePanel as removePanelFromTree,
  updatePanelRatio,
  nextPanelId,
  prevPanelId,
  findPanelSplitContext,
} from "./panel-tree";
import type {
  PersistedWorkspace,
  PersistedPanel,
  PersistedTab,
  PersistedLayout,
  AgentState,
  PickedElementResult,
} from "../electron.d";
import type { SetupStep, StepStatus } from "./project-store";

export interface ClosedPaneSnapshot {
  kind: "pane";
  paneId: string;
  tabId: string;
  panelId: string;
  workspacePath: string;
  contentType?: "terminal" | "browser" | "diff";
  url?: string;
  cwd?: string;
  title?: string;
}

export interface ClosedTabSnapshot {
  kind: "tab";
  tab: Tab;
  panelId: string;
  workspacePath: string;
  /** Per-pane metadata to restore */
  paneMetadata: Record<string, {
    contentType?: "terminal" | "browser" | "diff";
    url?: string;
    cwd?: string;
    title?: string;
  }>;
  /** If closing this tab caused the panel to be removed, store split context to recreate it */
  panelSplitContext?: {
    siblingId: string;
    direction: SplitDirection;
    ratio: number;
    position: "first" | "second";
  };
}

type ClosedSnapshot = ClosedPaneSnapshot | ClosedTabSnapshot;

const MAX_CLOSED_PANE_STACK = 10;

function newPaneId(): string {
  return `pane-${crypto.randomUUID()}`;
}

function newTabId(): string {
  return `tab-${crypto.randomUUID()}`;
}

export interface Tab {
  id: string;
  title: string;
  rootNode: PaneNode;
  focusedPaneId: string;
}

function createTab(title?: string, paneId?: string): Tab {
  const id = paneId ?? newPaneId();
  return {
    id: newTabId(),
    title: title ?? "Terminal",
    rootNode: { type: "leaf", paneId: id },
    focusedPaneId: id,
  };
}

export interface Panel {
  id: string;
  tabs: Tab[];
  selectedTabId: string;
  pinnedTabIds: string[];
}

export interface WorkspaceLayout {
  panelTree: PanelNode;
  panels: Record<string, Panel>;
  activePanelId: string;
}

function newPanelId(): string {
  return `panel-${crypto.randomUUID()}`;
}

function createSinglePanelLayout(
  tabs: Tab[],
  selectedTabId: string,
  pinnedTabIds: string[],
): WorkspaceLayout {
  const panelId = newPanelId();
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: { id: panelId, tabs, selectedTabId, pinnedTabIds },
    },
    activePanelId: panelId,
  };
}

function createEmptyLayout(): WorkspaceLayout {
  return createSinglePanelLayout([], "", []);
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
  /** Pending startup commands keyed by pane ID (for split-with-task) */
  pendingPaneCommands: Record<string, string>;
  /** Pane ID awaiting close confirmation (when agent is active) */
  pendingCloseConfirmPaneId: string | null;
  /** Tab ID awaiting close confirmation (when agent is active in a pane) */
  pendingCloseConfirmTabId: string | null;
  // Workspace activation
  setActiveWorkspace: (path: string) => void;

  // Layout restore — called once on startup
  loadPersistedLayout: () => Promise<void>;

  // Tab operations
  addTab: (paneId?: string) => void;
  addTerminalTab: (command: string, paneId?: string) => void;
  addBrowserTab: (url: string) => void;
  addDiffTab: () => void;
  duplicateTab: (tabId: string) => void;
  openOrFocusDiff: () => void;
  openDiffInNewPanel: () => void;
  closeTab: (tabId: string) => void;
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
  splitPaneAt: (
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
    contentType?: "terminal" | "browser" | "diff" | "task",
    paneCommand?: string,
  ) => void;
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
  setWebviewFocused: (paneId: string | null) => void;

  // Picked element
  setPickedElement: (paneId: string, result: PickedElementResult) => void;
  clearPickedElement: (paneId: string) => void;
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

function findPanelWithPane(layout: WorkspaceLayout, paneId: string): { panel: Panel; tab: Tab } | null {
  for (const panel of Object.values(layout.panels)) {
    const tab = panel.tabs.find((t) => hasPaneId(t.rootNode, paneId));
    if (tab) return { panel, tab };
  }
  return null;
}

function findPanelWithTab(layout: WorkspaceLayout, tabId: string): { panel: Panel; tab: Tab } | null {
  for (const panel of Object.values(layout.panels)) {
    const tab = panel.tabs.find((t) => t.id === tabId);
    if (tab) return { panel, tab };
  }
  return null;
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

// Cache the loaded layout so setActiveWorkspace can check it synchronously
let _cachedLayout: PersistedLayout | null = null;

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
  paneUrl: {},
  panePickedElement: {},
  webviewFocusedPaneId: null,
  layoutLoaded: false,
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

  addTab: (paneId?: string) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const tab = createTab(undefined, paneId);
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        tabs: [...p.tabs, tab],
        selectedTabId: tab.id,
      }));
    }),

  addTerminalTab: (command: string, paneId?: string) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const tab = createTab(undefined, paneId);
      const tabPaneId = tab.focusedPaneId;
      return {
        ...updatePanel(state, path, layout, panel.id, (p) => ({
          ...p,
          tabs: [...p.tabs, tab],
          selectedTabId: tab.id,
        })),
        pendingPaneCommands: {
          ...state.pendingPaneCommands,
          [tabPaneId]: command,
        },
      };
    }),

  addBrowserTab: (url: string) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
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
      return {
        paneContentType: { ...state.paneContentType, [paneId]: "browser" },
        paneUrl: { ...state.paneUrl, [paneId]: url },
        ...updatePanel(state, path, layout, panel.id, (p) => ({
          ...p,
          tabs: [...p.tabs, tab],
          selectedTabId: tab.id,
        })),
      };
    }),

  addDiffTab: () =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const paneId = newPaneId();
      const tab: Tab = {
        id: newTabId(),
        title: "Diff",
        rootNode: { type: "leaf", paneId, contentType: "diff" },
        focusedPaneId: paneId,
      };
      return {
        paneContentType: { ...state.paneContentType, [paneId]: "diff" },
        ...updatePanel(state, path, layout, panel.id, (p) => ({
          ...p,
          tabs: [...p.tabs, tab],
          selectedTabId: tab.id,
        })),
      };
    }),

  duplicateTab: (tabId: string) =>
    set((state) => {
      const wsPath = state.activeWorkspacePath;
      if (!wsPath) return state;
      const layout = state.workspaceLayouts[wsPath];
      if (!layout) return state;
      // Find the panel and tab
      let sourcePanel: Panel | undefined;
      let sourceTab: Tab | undefined;
      for (const panel of Object.values(layout.panels)) {
        const tab = panel.tabs.find((t) => t.id === tabId);
        if (tab) {
          sourcePanel = panel;
          sourceTab = tab;
          break;
        }
      }
      if (!sourcePanel || !sourceTab) return state;
      const sourcePaneId = sourceTab.focusedPaneId;
      const contentType = state.paneContentType[sourcePaneId] as string | undefined;
      const url = state.paneUrl[sourcePaneId] as string | undefined;
      const newPane = newPaneId();
      const newId = newTabId();
      if (contentType === "browser" && url) {
        let title: string;
        try {
          const parsed = new URL(url);
          title = parsed.host || url;
        } catch {
          title = url;
        }
        const tab: Tab = {
          id: newId,
          title,
          rootNode: { type: "leaf", paneId: newPane, contentType: "browser", url },
          focusedPaneId: newPane,
        };
        return {
          paneContentType: { ...state.paneContentType, [newPane]: "browser" },
          paneUrl: { ...state.paneUrl, [newPane]: url },
          ...updatePanel(state, wsPath, layout, sourcePanel.id, (p) => ({
            ...p,
            tabs: [...p.tabs, tab],
            selectedTabId: tab.id,
          })),
        };
      } else if (contentType === "diff") {
        const tab: Tab = {
          id: newId,
          title: "Diff",
          rootNode: { type: "leaf", paneId: newPane, contentType: "diff" },
          focusedPaneId: newPane,
        };
        return {
          paneContentType: { ...state.paneContentType, [newPane]: "diff" },
          ...updatePanel(state, wsPath, layout, sourcePanel.id, (p) => ({
            ...p,
            tabs: [...p.tabs, tab],
            selectedTabId: tab.id,
          })),
        };
      } else {
        // Terminal tab
        const tab = createTab(sourceTab.title);
        return updatePanel(state, wsPath, layout, sourcePanel.id, (p) => ({
          ...p,
          tabs: [...p.tabs, tab],
          selectedTabId: tab.id,
        }));
      }
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
        ...updatePanel(state, ctx.path, ctx.layout, ctx.panel.id, (p) => ({
          ...p,
          tabs: [...p.tabs, tab],
          selectedTabId: tab.id,
        })),
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
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;

      // Mark all panes in the closing tab as explicitly closed
      const closingTab = panel.tabs.find((s) => s.id === tabId);
      const deadPaneIds: string[] = [];
      const newClosedPaneIds = new Set(state.closedPaneIds);
      if (closingTab) {
        for (const pid of allPaneIds(closingTab.rootNode)) {
          newClosedPaneIds.add(pid);
          deadPaneIds.push(pid);
        }
      }

      const idx = panel.tabs.findIndex((s) => s.id === tabId);
      const newTabs = panel.tabs.filter((s) => s.id !== tabId);
      const newSelected =
        newTabs.length === 0
          ? ""
          : tabId === panel.selectedTabId
            ? newTabs[Math.min(idx, newTabs.length - 1)].id
            : panel.selectedTabId;

      // Snapshot the full tab so it can be restored with all its panes
      let newStack = state.closedPaneStack;
      if (closingTab) {
        const paneMetadata: ClosedTabSnapshot["paneMetadata"] = {};
        for (const pid of deadPaneIds) {
          paneMetadata[pid] = {
            contentType: state.paneContentType[pid],
            url: state.paneUrl[pid],
            cwd: state.paneCwd[pid],
            title: state.paneTitle[pid],
          };
        }
        // If this was the last tab and the panel will be auto-closed, capture split context
        const panelIds = Object.keys(layout.panels);
        const willRemovePanel = newTabs.length === 0 && panelIds.length > 1;
        const tabSnapshot: ClosedTabSnapshot = {
          kind: "tab",
          tab: closingTab,
          panelId: panel.id,
          workspacePath: path,
          paneMetadata,
          ...(willRemovePanel && {
            panelSplitContext: findPanelSplitContext(layout.panelTree, panel.id) ?? undefined,
          }),
        };
        newStack = [tabSnapshot, ...state.closedPaneStack].slice(0, MAX_CLOSED_PANE_STACK);
      }

      // Clean up metadata for dead panes
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

      // If this panel has no tabs left and there are other panels, auto-close it
      const panelIds = Object.keys(layout.panels);
      if (newTabs.length === 0 && panelIds.length > 1) {
        const newPanelTree = removePanelFromTree(layout.panelTree, panel.id);
        const { [panel.id]: _, ...remainingPanels } = layout.panels;
        const remainingIds = Object.keys(remainingPanels);
        const newActivePanelId = remainingIds.includes(layout.activePanelId)
          ? layout.activePanelId
          : remainingIds[0];
        return {
          closedPaneIds: newClosedPaneIds,
          closedPaneStack: newStack,
          paneCwd: newCwd,
          paneTitle: newTitle,
          paneAgentStatus: newAgentStatus,
          paneContentType: newContentType,
          paneUrl: newPaneUrl,
          workspaceLayouts: {
            ...state.workspaceLayouts,
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
        closedPaneIds: newClosedPaneIds,
        closedPaneStack: newStack,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneUrl: newPaneUrl,
        ...updatePanel(state, path, layout, panel.id, (p) => ({
          ...p,
          tabs: newTabs,
          selectedTabId: newSelected,
          pinnedTabIds: (p.pinnedTabIds ?? []).filter(
            (id) => id !== tabId,
          ),
        })),
      };
    }),

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
      const { path, layout, panel } = ctx;
      const lookup = new Map(panel.tabs.map((s) => [s.id, s]));
      const reordered = tabIds
        .map((id) => lookup.get(id))
        .filter(Boolean) as Tab[];
      if (reordered.length !== panel.tabs.length) return state;
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        tabs: reordered,
      }));
    }),

  togglePinTab: (tabId: string) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const pinned = panel.pinnedTabIds ?? [];
      const isPinned = pinned.includes(tabId);
      let newPinned: string[];
      let newTabs: Tab[];
      if (isPinned) {
        // Unpin: remove from pinned list, move to after last pinned tab
        newPinned = pinned.filter((id) => id !== tabId);
        const tab = panel.tabs.find((s) => s.id === tabId);
        if (!tab) return state;
        const others = panel.tabs.filter((s) => s.id !== tabId);
        const insertIdx = newPinned.length;
        newTabs = [
          ...others.slice(0, insertIdx),
          tab,
          ...others.slice(insertIdx),
        ];
      } else {
        newPinned = [...pinned, tabId];
        const tab = panel.tabs.find((s) => s.id === tabId);
        if (!tab) return state;
        const others = panel.tabs.filter((s) => s.id !== tabId);
        const insertIdx = pinned.length;
        newTabs = [
          ...others.slice(0, insertIdx),
          tab,
          ...others.slice(insertIdx),
        ];
      }
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        tabs: newTabs,
        pinnedTabIds: newPinned,
      }));
    }),

  splitPane: (direction: SplitDirection) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const tab = panel.tabs.find((s) => s.id === panel.selectedTabId);
      if (!tab) return state;
      const newPane = newPaneId();
      const newRoot = insertSplit(
        tab.rootNode,
        tab.focusedPaneId,
        direction,
        newPane,
      );
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        tabs: p.tabs.map((s) =>
          s.id === tab.id
            ? { ...s, rootNode: newRoot, focusedPaneId: newPane }
            : s,
        ),
      }));
    }),

  splitPaneAt: (
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
    contentType?: "terminal" | "browser" | "diff" | "task",
    paneCommand?: string,
  ) =>
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const tab = panel.tabs.find((s) =>
        hasPaneId(s.rootNode, targetPaneId),
      );
      if (!tab) return state;
      const newPane = newPaneId();
      // "task" panes are terminals that auto-run a command -- don't persist as a content type
      const treeContentType = contentType === "task" ? undefined : contentType;
      const newRoot = insertSplitAt(
        tab.rootNode,
        targetPaneId,
        direction,
        newPane,
        position,
        treeContentType,
      );
      return {
        ...updatePanel(state, path, layout, panel.id, (p) => ({
          ...p,
          tabs: p.tabs.map((s) =>
            s.id === tab.id
              ? { ...s, rootNode: newRoot, focusedPaneId: newPane }
              : s,
          ),
        })),
        ...(treeContentType && {
          paneContentType: {
            ...state.paneContentType,
            [newPane]: treeContentType,
          },
        }),
        ...(paneCommand && {
          pendingPaneCommands: {
            ...state.pendingPaneCommands,
            [newPane]: paneCommand,
          },
        }),
      };
    }),

  movePaneToTarget: (
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;

      const src = findPanelWithPane(layout, sourcePaneId);
      const tgt = findPanelWithPane(layout, targetPaneId);
      if (!src || !tgt) return state;
      const { panel: sourcePanel, tab: sourceTab } = src;
      const { panel: targetPanel, tab: targetTab } = tgt;

      // Same panel, same tab — in-place move
      if (sourcePanel.id === targetPanel.id && sourceTab.id === targetTab.id) {
        const newRoot = movePane(sourceTab.rootNode, sourcePaneId, targetPaneId, direction, position);
        if (newRoot === null) return state;
        return updatePanel(state, path, layout, sourcePanel.id, (p) => ({
          ...p,
          tabs: p.tabs.map((s) =>
            s.id === sourceTab.id ? { ...s, rootNode: newRoot, focusedPaneId: sourcePaneId } : s,
          ),
        }));
      }

      // Same panel, cross-tab
      if (sourcePanel.id === targetPanel.id) {
        const sourceRootAfterRemove = removePane(sourceTab.rootNode, sourcePaneId);
        const newTargetRoot = insertSplitAt(targetTab.rootNode, targetPaneId, direction, sourcePaneId, position);

        let newTabs: Tab[];
        if (sourceRootAfterRemove === null) {
          newTabs = sourcePanel.tabs
            .filter((s) => s.id !== sourceTab.id)
            .map((s) => s.id === targetTab.id ? { ...s, rootNode: newTargetRoot, focusedPaneId: sourcePaneId } : s);
        } else {
          newTabs = sourcePanel.tabs.map((s) => {
            if (s.id === sourceTab.id) {
              const ids = allPaneIds(sourceRootAfterRemove);
              return { ...s, rootNode: sourceRootAfterRemove, focusedPaneId: s.focusedPaneId === sourcePaneId ? ids[0] : s.focusedPaneId };
            }
            if (s.id === targetTab.id) return { ...s, rootNode: newTargetRoot, focusedPaneId: sourcePaneId };
            return s;
          });
        }

        const newSelectedTabId =
          sourcePanel.selectedTabId === sourceTab.id && sourceRootAfterRemove === null
            ? targetTab.id : sourcePanel.selectedTabId;

        return updatePanel(state, path, layout, sourcePanel.id, (p) => ({
          ...p,
          tabs: newTabs,
          selectedTabId: newSelectedTabId,
          pinnedTabIds: sourceRootAfterRemove === null
            ? (p.pinnedTabIds ?? []).filter((id) => id !== sourceTab.id) : p.pinnedTabIds,
        }));
      }

      // Cross-panel move
      const sourceRootAfterRemove = removePane(sourceTab.rootNode, sourcePaneId);
      const newTargetRoot = insertSplitAt(targetTab.rootNode, targetPaneId, direction, sourcePaneId, position);

      let newPanels = { ...layout.panels };
      let newPanelTree = layout.panelTree;

      // Update target panel
      newPanels[targetPanel.id] = {
        ...targetPanel,
        tabs: targetPanel.tabs.map((t) =>
          t.id === targetTab.id ? { ...t, rootNode: newTargetRoot, focusedPaneId: sourcePaneId } : t,
        ),
        selectedTabId: targetTab.id,
      };

      // Update source panel
      if (sourceRootAfterRemove === null) {
        // Source tab's only pane was moved — remove the tab
        const remainingTabs = sourcePanel.tabs.filter((t) => t.id !== sourceTab.id);
        if (remainingTabs.length === 0 && Object.keys(newPanels).length > 1) {
          // Source panel empty — remove it
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
            selectedTabId: sourcePanel.selectedTabId === sourceTab.id ? remainingTabs[0].id : sourcePanel.selectedTabId,
            pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter((id) => id !== sourceTab.id),
          };
        }
      } else {
        const ids = allPaneIds(sourceRootAfterRemove);
        newPanels[sourcePanel.id] = {
          ...sourcePanel,
          tabs: sourcePanel.tabs.map((t) => {
            if (t.id === sourceTab.id) {
              return { ...t, rootNode: sourceRootAfterRemove, focusedPaneId: t.focusedPaneId === sourcePaneId ? ids[0] : t.focusedPaneId };
            }
            return t;
          }),
        };
      }

      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: { ...layout, panelTree: newPanelTree, panels: newPanels, activePanelId: targetPanel.id },
        },
      };
    }),

  moveTabToPane: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;

      const src = findPanelWithTab(layout, tabId);
      const tgt = findPanelWithPane(layout, targetPaneId);
      if (!src || !tgt) return state;
      const { panel: sourcePanel, tab: sourceTab } = src;
      const { panel: targetPanel, tab: targetTab } = tgt;
      if (sourceTab.id === targetTab.id) return state;

      // Build the new target root
      let newTargetRoot: PaneNode;
      let focusPaneId: string;
      if (sourceTab.rootNode.type === "leaf") {
        focusPaneId = sourceTab.rootNode.paneId;
        newTargetRoot = insertSplitAt(targetTab.rootNode, targetPaneId, direction, focusPaneId, position);
      } else {
        focusPaneId = allPaneIds(sourceTab.rootNode)[0];
        newTargetRoot = insertSubtreeAt(targetTab.rootNode, targetPaneId, direction, sourceTab.rootNode, position);
      }

      // Same panel — update tabs in place
      if (sourcePanel.id === targetPanel.id) {
        const newTabs = sourcePanel.tabs
          .filter((s) => s.id !== sourceTab.id)
          .map((s) => s.id === targetTab.id ? { ...s, rootNode: newTargetRoot, focusedPaneId: focusPaneId } : s);
        const newSelectedTabId = sourcePanel.selectedTabId === sourceTab.id ? targetTab.id : sourcePanel.selectedTabId;
        return updatePanel(state, path, layout, sourcePanel.id, (p) => ({
          ...p,
          tabs: newTabs,
          selectedTabId: newSelectedTabId,
          pinnedTabIds: (p.pinnedTabIds ?? []).filter((id) => id !== sourceTab.id),
        }));
      }

      // Cross-panel
      let newPanels = { ...layout.panels };
      let newPanelTree = layout.panelTree;

      // Update target panel
      newPanels[targetPanel.id] = {
        ...targetPanel,
        tabs: targetPanel.tabs.map((t) =>
          t.id === targetTab.id ? { ...t, rootNode: newTargetRoot, focusedPaneId: focusPaneId } : t,
        ),
        selectedTabId: targetTab.id,
      };

      // Remove tab from source panel
      const remainingTabs = sourcePanel.tabs.filter((t) => t.id !== sourceTab.id);
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
          selectedTabId: sourcePanel.selectedTabId === sourceTab.id ? remainingTabs[0].id : sourcePanel.selectedTabId,
          pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter((id) => id !== sourceTab.id),
        };
      }

      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: { ...layout, panelTree: newPanelTree, panels: newPanels, activePanelId: targetPanel.id },
        },
      };
    }),

  extractPaneToTab: (paneId: string, targetPanelId?: string) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;

      const src = findPanelWithPane(layout, paneId);
      if (!src) return state;
      const { panel: sourcePanel, tab: sourceTab } = src;
      const destPanelId = targetPanelId ?? sourcePanel.id;
      const destPanel = layout.panels[destPanelId];
      if (!destPanel) return state;

      // If the pane is the only pane in its tab and destination is the same panel, just select it
      if (
        sourcePanel.id === destPanelId &&
        sourceTab.rootNode.type === "leaf" &&
        sourceTab.rootNode.paneId === paneId
      ) {
        return updatePanel(state, path, layout, sourcePanel.id, (p) => ({
          ...p,
          selectedTabId: sourceTab.id,
        }));
      }

      // If pane is the only pane in its tab, move the whole tab to the target panel
      if (sourceTab.rootNode.type === "leaf" && sourceTab.rootNode.paneId === paneId) {
        if (sourcePanel.id === destPanelId) return state;
        // Use moveTabToPanel logic
        const remainingTabs = sourcePanel.tabs.filter((t) => t.id !== sourceTab.id);
        let newPanels = { ...layout.panels };
        let newPanelTree = layout.panelTree;

        newPanels[destPanelId] = {
          ...destPanel,
          tabs: [...destPanel.tabs, sourceTab],
          selectedTabId: sourceTab.id,
        };

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
            selectedTabId: sourcePanel.selectedTabId === sourceTab.id ? remainingTabs[0].id : sourcePanel.selectedTabId,
            pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter((id) => id !== sourceTab.id),
          };
        }

        return {
          workspaceLayouts: {
            ...state.workspaceLayouts,
            [path]: { ...layout, panelTree: newPanelTree, panels: newPanels, activePanelId: destPanelId },
          },
        };
      }

      // Remove the pane from the source tab
      const remaining = removePane(sourceTab.rootNode, paneId);
      if (!remaining) return state;

      const ids = allPaneIds(remaining);
      const newFocused = sourceTab.focusedPaneId === paneId ? ids[0] : sourceTab.focusedPaneId;

      const newTab: Tab = {
        id: newTabId(),
        title: "Terminal",
        rootNode: { type: "leaf", paneId },
        focusedPaneId: paneId,
      };

      if (sourcePanel.id === destPanelId) {
        // Same panel — just add new tab
        const newTabs = sourcePanel.tabs.map((s) =>
          s.id === sourceTab.id ? { ...s, rootNode: remaining, focusedPaneId: newFocused } : s,
        );
        newTabs.push(newTab);
        return updatePanel(state, path, layout, sourcePanel.id, (p) => ({
          ...p,
          tabs: newTabs,
          selectedTabId: newTab.id,
        }));
      }

      // Cross-panel — update source panel's tab, add new tab to destination panel
      let newPanels = { ...layout.panels };
      newPanels[sourcePanel.id] = {
        ...sourcePanel,
        tabs: sourcePanel.tabs.map((t) =>
          t.id === sourceTab.id ? { ...t, rootNode: remaining, focusedPaneId: newFocused } : t,
        ),
      };
      newPanels[destPanelId] = {
        ...destPanel,
        tabs: [...destPanel.tabs, newTab],
        selectedTabId: newTab.id,
      };

      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: { ...layout, panels: newPanels, activePanelId: destPanelId },
        },
      };
    }),

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
    window.electronAPI.tasks.abandonForPane(paneId, currentTitle).catch(console.error);
    const state = get();
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const { path, panel } = ctx;

    const tab = panel.tabs.find((s) => hasPaneId(s.rootNode, paneId));
    if (!tab) return;

    const remaining = removePane(tab.rootNode, paneId);
    if (remaining === null) {
      // Last pane in tab -- closeTab will push a tab snapshot
      get().closeTab(tab.id);
      return;
    }

    const snapshot: ClosedPaneSnapshot = {
      kind: "pane",
      paneId,
      tabId: tab.id,
      panelId: panel.id,
      workspacePath: path,
      contentType: state.paneContentType[paneId],
      url: state.paneUrl[paneId],
      cwd: state.paneCwd[paneId],
      title: state.paneTitle[paneId],
    };

    const ids = allPaneIds(remaining);
    const newFocused =
      tab.focusedPaneId === paneId ? ids[0] : tab.focusedPaneId;

    set((s) => {
      const currentCtx = getActivePanelContext(s);
      if (!currentCtx) return s;
      const newClosedPaneIds = new Set(s.closedPaneIds);
      newClosedPaneIds.add(paneId);
      const newStack = [snapshot, ...s.closedPaneStack].slice(0, MAX_CLOSED_PANE_STACK);
      const newCwd = { ...s.paneCwd };
      const newTitle = { ...s.paneTitle };
      const newAgentStatus = { ...s.paneAgentStatus };
      const newContentType = { ...s.paneContentType };
      const newPaneUrl = { ...s.paneUrl };
      delete newCwd[paneId];
      delete newTitle[paneId];
      delete newAgentStatus[paneId];
      delete newContentType[paneId];
      delete newPaneUrl[paneId];
      return {
        closedPaneIds: newClosedPaneIds,
        closedPaneStack: newStack,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneUrl: newPaneUrl,
        ...updatePanel(s, currentCtx.path, currentCtx.layout, currentCtx.panel.id, (p) => ({
          ...p,
          tabs: p.tabs.map((t) =>
            t.id === tab.id
              ? { ...t, rootNode: remaining, focusedPaneId: newFocused }
              : t,
          ),
        })),
      };
    });
  },

  reopenClosedPane: () => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return;
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const { layout, panel } = ctx;

    const idx = state.closedPaneStack.findIndex((s) => s.workspacePath === path);
    if (idx === -1) return;
    const snapshot = state.closedPaneStack[idx];

    // Restore to the original panel if it still exists, otherwise fall back to active panel
    const targetPanelId = snapshot.panelId && layout.panels[snapshot.panelId]
      ? snapshot.panelId
      : panel.id;
    const targetPanel = layout.panels[targetPanelId]!;

    if (snapshot.kind === "tab") {
      set((s) => {
        const currentCtx = getActiveLayoutContext(s);
        if (!currentCtx) return s;
        const { path: ctxPath, layout: ctxLayout } = currentCtx;
        const newStack = [...s.closedPaneStack];
        newStack.splice(idx, 1);

        const newContentType = { ...s.paneContentType };
        const newCwd = { ...s.paneCwd };
        const newUrl = { ...s.paneUrl };
        const newTitle = { ...s.paneTitle };
        const newClosedPaneIds = new Set(s.closedPaneIds);
        for (const [pid, meta] of Object.entries(snapshot.paneMetadata)) {
          if (meta.contentType) newContentType[pid] = meta.contentType;
          if (meta.cwd) newCwd[pid] = meta.cwd;
          if (meta.url) newUrl[pid] = meta.url;
          if (meta.title) newTitle[pid] = meta.title;
          newClosedPaneIds.delete(pid);
        }

        // If the original panel was removed and we have split context, recreate the panel
        const originalPanelGone = !ctxLayout.panels[snapshot.panelId];
        const sc = snapshot.panelSplitContext;
        if (originalPanelGone && sc && ctxLayout.panels[sc.siblingId]) {
          const restoredPanelId = snapshot.panelId;
          const newPanel: Panel = {
            id: restoredPanelId,
            tabs: [snapshot.tab],
            selectedTabId: snapshot.tab.id,
            pinnedTabIds: [],
          };
          const finalTree = insertPanelSplit(
            ctxLayout.panelTree,
            sc.siblingId,
            sc.direction,
            restoredPanelId,
            sc.position,
            sc.ratio,
          );

          return {
            closedPaneStack: newStack,
            closedPaneIds: newClosedPaneIds,
            paneContentType: newContentType,
            paneCwd: newCwd,
            paneUrl: newUrl,
            paneTitle: newTitle,
            workspaceLayouts: {
              ...s.workspaceLayouts,
              [ctxPath]: {
                ...ctxLayout,
                panelTree: finalTree,
                panels: { ...ctxLayout.panels, [restoredPanelId]: newPanel },
                activePanelId: restoredPanelId,
              },
            },
          };
        }

        // Original panel still exists (or no split context) — add tab to target panel
        return {
          closedPaneStack: newStack,
          closedPaneIds: newClosedPaneIds,
          paneContentType: newContentType,
          paneCwd: newCwd,
          paneUrl: newUrl,
          paneTitle: newTitle,
          ...updatePanel(s, ctxPath, ctxLayout, targetPanelId, (p) => ({
            ...p,
            tabs: [...p.tabs, snapshot.tab],
            selectedTabId: snapshot.tab.id,
          })),
        };
      });
      return;
    }

    // Single pane restore
    const contentType = snapshot.contentType ?? "terminal";
    const originalTab = targetPanel.tabs.find((s) => s.id === snapshot.tabId);

    // Reuse the original pane ID so the daemon session (still alive during
    // the grace period) is reattached instead of creating a fresh terminal.
    const restoredPaneId = snapshot.paneId;
    let selectedTabId: string;
    let tabsUpdater: (tabs: Tab[]) => Tab[];

    if (originalTab) {
      selectedTabId = originalTab.id;
      const newRoot = insertSplitAt(
        originalTab.rootNode,
        originalTab.focusedPaneId,
        "horizontal",
        restoredPaneId,
        "second",
        contentType,
      );
      tabsUpdater = (tabs) =>
        tabs.map((t) =>
          t.id === originalTab.id
            ? { ...t, rootNode: newRoot, focusedPaneId: restoredPaneId }
            : t,
        );
    } else {
      const newTab: Tab = {
        id: newTabId(),
        title: snapshot.title ?? "Terminal",
        rootNode: { type: "leaf", paneId: restoredPaneId },
        focusedPaneId: restoredPaneId,
      };
      selectedTabId = newTab.id;
      tabsUpdater = (tabs) => [...tabs, newTab];
    }

    set((s) => {
      const currentCtx = getActiveLayoutContext(s);
      if (!currentCtx) return s;
      const newStack = [...s.closedPaneStack];
      newStack.splice(idx, 1);
      return {
        closedPaneStack: newStack,
        paneContentType: {
          ...s.paneContentType,
          [restoredPaneId]: contentType,
        },
        ...(snapshot.cwd && {
          paneCwd: { ...s.paneCwd, [restoredPaneId]: snapshot.cwd },
        }),
        ...(snapshot.url && {
          paneUrl: { ...s.paneUrl, [restoredPaneId]: snapshot.url },
        }),
        ...updatePanel(s, currentCtx.path, currentCtx.layout, targetPanelId, (p) => ({
          ...p,
          selectedTabId,
          tabs: tabsUpdater(p.tabs),
        })),
      };
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
        const updateLeafUrl = (node: PaneNode): PaneNode => {
          if (node.type === "leaf") {
            return node.paneId === paneId ? { ...node, url } : node;
          }
          const first = updateLeafUrl(node.first);
          const second = updateLeafUrl(node.second);
          if (first === node.first && second === node.second) return node;
          return { ...node, first, second };
        };
        const updatedTabs = panel.tabs.map((s) => {
          const newRoot = updateLeafUrl(s.rootNode);
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
      // Update the tree node's contentType so it persists across reloads
      const newState: Partial<AppState> = { paneContentType: newContentType };
      const ctx = getActivePanelContext(state);
      if (ctx) {
        const { path, layout, panel } = ctx;
        const treeType = contentType === "terminal" ? undefined : contentType;
        const updatedTabs = panel.tabs.map((s) => {
          const newRoot = updateLeafContentType(s.rootNode, paneId, treeType);
          return newRoot === s.rootNode ? s : { ...s, rootNode: newRoot };
        });
        Object.assign(newState, updatePanel(state, path, layout, panel.id, (p) => ({
          ...p,
          tabs: updatedTabs,
        })));
      }
      return newState;
    }),

  setWebviewFocused: (paneId: string | null) =>
    set({ webviewFocusedPaneId: paneId }),

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
      const { path, layout, panel } = ctx;

      const newPId = newPanelId();

      // Move the currently selected tab to the new panel; if no tabs, give both panels empty state
      const selectedTab = panel.tabs.find((t) => t.id === panel.selectedTabId);
      let sourceTabs: Tab[];
      let sourceSelected: string;
      let targetTabs: Tab[];
      let targetSelected: string;

      if (selectedTab) {
        sourceTabs = panel.tabs.filter((t) => t.id !== selectedTab.id);
        // If source panel would be empty, create a fresh tab for it
        if (sourceTabs.length === 0) {
          const fresh = createTab();
          sourceTabs = [fresh];
          sourceSelected = fresh.id;
        } else {
          sourceSelected = sourceTabs[0].id;
        }
        targetTabs = [selectedTab];
        targetSelected = selectedTab.id;
      } else {
        sourceTabs = panel.tabs;
        sourceSelected = panel.selectedTabId;
        targetTabs = [];
        targetSelected = "";
      }

      const newPanelTree = insertPanelSplit(layout.panelTree, panel.id, direction, newPId);
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            panelTree: newPanelTree,
            panels: {
              ...layout.panels,
              [panel.id]: { ...panel, tabs: sourceTabs, selectedTabId: sourceSelected },
              [newPId]: { id: newPId, tabs: targetTabs, selectedTabId: targetSelected, pinnedTabIds: [] },
            },
            activePanelId: newPId,
          },
        },
      };
    }),

  closePanel: (panelId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout) return state;
      const panel = layout.panels[panelId];
      if (!panel) return state;

      // Mark all panes in all tabs of this panel as closed
      const newClosedPaneIds = new Set(state.closedPaneIds);
      const deadPaneIds: string[] = [];
      for (const tab of panel.tabs) {
        for (const pid of allPaneIds(tab.rootNode)) {
          newClosedPaneIds.add(pid);
          deadPaneIds.push(pid);
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

      // Remove from panel tree
      const newPanelTree = removePanelFromTree(layout.panelTree, panelId);
      const { [panelId]: _, ...remainingPanels } = layout.panels;

      if (newPanelTree === null) {
        // Last panel -- recreate empty layout
        return {
          closedPaneIds: newClosedPaneIds,
          paneCwd: newCwd,
          paneTitle: newTitle,
          paneAgentStatus: newAgentStatus,
          paneContentType: newContentType,
          paneUrl: newPaneUrl,
          workspaceLayouts: {
            ...state.workspaceLayouts,
            [path]: createEmptyLayout(),
          },
        };
      }

      // If closing the active panel, focus the next one
      let newActivePanelId = layout.activePanelId;
      if (panelId === layout.activePanelId) {
        const next = nextPanelId(newPanelTree, panelId);
        newActivePanelId = next ?? allPanelIds(newPanelTree)[0];
      }

      return {
        closedPaneIds: newClosedPaneIds,
        paneCwd: newCwd,
        paneTitle: newTitle,
        paneAgentStatus: newAgentStatus,
        paneContentType: newContentType,
        paneUrl: newPaneUrl,
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            panelTree: newPanelTree,
            panels: remainingPanels,
            activePanelId: newActivePanelId,
          },
        },
      };
    }),

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
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      const layout = state.workspaceLayouts[path];
      if (!layout) return state;
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            panelTree: updatePanelRatio(layout.panelTree, firstPanelId, ratio),
          },
        },
      };
    }),

  moveTabToPanel: (tabId: string, targetPanelId: string) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;

      const src = findPanelWithTab(layout, tabId);
      if (!src) return state;
      const { panel: sourcePanel, tab } = src;
      const targetPanel = layout.panels[targetPanelId];
      if (!targetPanel || sourcePanel.id === targetPanelId) return state;

      const sourceTabs = sourcePanel.tabs.filter((t) => t.id !== tabId);
      const sourceSelected = sourceTabs.length === 0
        ? ""
        : tabId === sourcePanel.selectedTabId
          ? sourceTabs[0].id
          : sourcePanel.selectedTabId;

      const targetTabs = [...targetPanel.tabs, tab];
      const targetSelected = tab.id;

      if (sourceTabs.length === 0) {
        const newPanelTree = removePanelFromTree(layout.panelTree, sourcePanel.id);
        if (newPanelTree === null) return state;
        const { [sourcePanel.id]: _, ...remainingPanels } = layout.panels;
        return {
          workspaceLayouts: {
            ...state.workspaceLayouts,
            [path]: {
              ...layout,
              panelTree: newPanelTree,
              panels: {
                ...remainingPanels,
                [targetPanelId]: { ...targetPanel, tabs: targetTabs, selectedTabId: targetSelected },
              },
              activePanelId: targetPanelId,
            },
          },
        };
      }

      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            panels: {
              ...layout.panels,
              [sourcePanel.id]: {
                ...sourcePanel,
                tabs: sourceTabs,
                selectedTabId: sourceSelected,
                pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter((id) => id !== tabId),
              },
              [targetPanelId]: { ...targetPanel, tabs: targetTabs, selectedTabId: targetSelected },
            },
            activePanelId: targetPanelId,
          },
        },
      };
    }),

  splitPanelWithTab: (tabId: string, targetPanelId: string, direction: SplitDirection) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const { path, layout } = ctx;

      const src = findPanelWithTab(layout, tabId);
      if (!src) return state;
      const { panel: sourcePanel, tab } = src;
      const targetPanel = layout.panels[targetPanelId];
      if (!targetPanel) return state;

      const newPId = newPanelId();

      // Remove the tab from its source panel
      const sourceTabs = sourcePanel.tabs.filter((t) => t.id !== tabId);
      const sourceSelected = sourceTabs.length === 0
        ? ""
        : tabId === sourcePanel.selectedTabId
          ? sourceTabs[0].id
          : sourcePanel.selectedTabId;

      // Create the new panel with the dragged tab
      const newPanelTree = insertPanelSplit(layout.panelTree, targetPanelId, direction, newPId);

      // If source is the only tab, create a fresh one so the panel isn't empty
      let finalSourceTabs = sourceTabs;
      let finalSourceSelected = sourceSelected;
      if (finalSourceTabs.length === 0) {
        const fresh = createTab();
        finalSourceTabs = [fresh];
        finalSourceSelected = fresh.id;
      }

      const panels = {
        ...layout.panels,
        [sourcePanel.id]: {
          ...sourcePanel,
          tabs: finalSourceTabs,
          selectedTabId: finalSourceSelected,
          pinnedTabIds: (sourcePanel.pinnedTabIds ?? []).filter((id) => id !== tabId),
        },
        [newPId]: { id: newPId, tabs: [tab], selectedTabId: tab.id, pinnedTabIds: [] as string[] },
      };

      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [path]: {
            ...layout,
            panelTree: newPanelTree,
            panels,
            activePanelId: newPId,
          },
        },
      };
    }),

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
      let newPanels = { ...layout.panels };
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
    set((state) => {
      const ctx = getActivePanelContext(state);
      if (!ctx) return state;
      const { path, layout, panel } = ctx;
      const tab = panel.tabs.find((t) => t.id === panel.selectedTabId);
      if (!tab) return state;
      const newRoot = updateRatio(tab.rootNode, firstPaneId, ratio);
      if (newRoot === tab.rootNode) return state;
      return updatePanel(state, path, layout, panel.id, (p) => ({
        ...p,
        tabs: p.tabs.map((t) =>
          t.id === tab.id ? { ...t, rootNode: newRoot } : t,
        ),
      }));
    }),

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

  window.electronAPI?.layout.save(persisted);
}

/** Debounced save of the active workspace's layout to disk */
function saveActiveWorkspaceLayout(): void {
  if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => {
    saveLayoutTimer = null;
    flushLayoutSave();
  }, 500);
}

// Subscribe to store changes and auto-save layout
useAppStore.subscribe((state, prevState) => {
  if (
    state.workspaceLayouts !== prevState.workspaceLayouts ||
    state.activeWorkspacePath !== prevState.activeWorkspacePath ||
    state.paneAgentStatus !== prevState.paneAgentStatus
  ) {
    saveActiveWorkspaceLayout();
  }
});

// Flush any pending layout save before the window unloads (app quit / reload)
// so that recently-created panes (e.g. diff, browser) are never lost.
window.addEventListener("beforeunload", () => {
  if (saveLayoutTimer) {
    clearTimeout(saveLayoutTimer);
    saveLayoutTimer = null;
    flushLayoutSave();
  }
});
