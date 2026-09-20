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
} from "../lib/layout/pane-tree";
import {
  allPanelIds,
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
import type { LayoutCommand } from "../lib/layout/commands";
import type {
  AgentState,
  LayoutChangedPayload,
  PickedElementResult,
} from "../electron.d";
import type { SetupStep, StepStatus } from "./project-store";
import type { Location } from "./navigation-history-store";
import type { DetachedTabPayload } from "./detach-types";
import { isHomePath } from "../lib/home-path";
import { useProjectStore } from "./project-store";

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

export interface AppState {
  /**
   * This renderer's replica of the Manor server's layout, per workspace
   * (ADR-179 D1). Read freely; never written by an action — the only writer
   * is `applyLayoutChanged`, which replaces a workspace when the server says
   * so. Absent until the workspace is first visited or first changed.
   */
  workspaceLayouts: Record<string, WorkspaceLayout>;
  /** The server version each replica is at. An older broadcast is dropped. */
  layoutVersions: Record<string, number>;
  /**
   * The server's layout for every workspace it knows, opened here or not.
   *
   * `workspaceLayouts` holds only the workspaces this window has opened,
   * because rendering one mounts its panes and mounting a pane creates a PTY.
   * This is where the rest wait: `setActiveWorkspace` adopts from here on the
   * first visit, which is what the old `_cachedLayout` did with the file it
   * had read.
   */
  serverLayouts: Record<string, WorkspaceLayout>;
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
  //
  // Every one of these sends a command and returns the ids it minted; the tab
  // itself appears when the server's broadcast lands, a frame later (ADR-179
  // D1). They answer null only when there is no workspace to put a tab in —
  // a workspace with no *panel* is fine, because the server makes one.
  /**
   * Returns the IDs of the tab it created, or null when there is no active
   * workspace. `adoptPaneId` lets the new pane reuse a PTY session main
   * already prewarmed under that ID; everything else lets the store mint one.
   */
  addTab: (adoptPaneId?: string) => { tabId: string; paneId: string } | null;
  addTerminalTab: (command: string) => { tabId: string; paneId: string } | null;
  addBrowserTab: (
    url: string,
    opts?: { background?: boolean },
  ) => { tabId: string; paneId: string } | null;
  addDiffTab: () => void;
  /** Returns the id of the tab it minted, or null when there is nothing to
   *  duplicate. The duplicate's panes are fresh ids, not the source's. */
  duplicateTab: (tabId: string) => string | null;
  /** Returns the id of the tab the diff is in, or null when there is no
   *  active workspace to open it in. */
  openOrFocusDiff: () => string | null;
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
  /** Returns the id of the tab the pane ends up in, or null when there is no
   *  such pane. */
  extractPaneToTab: (paneId: string, targetPanelId?: string) => string | null;
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
  /**
   * A title the host already knows — an OSC title from the PTY stream, or a
   * stale title cleared when a new agent starts in the pane. Local only: the
   * server derives `lastTitle` from the same daemon event (ADR-179 D3), so
   * sending it back would be one `layout.apply` per viewer per title change.
   */
  setPaneTitleFromStream: (paneId: string, title: string | null) => void;

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

/**
 * `{ panelId }` for the panel this window is on, or `{}` for a workspace with
 * no layout yet — a command that names no panel lands in the one the server
 * creates for it, which is exactly right for the first tab of a new
 * workspace.
 */
function activePanelOf(state: AppState): { panelId?: string } {
  const ctx = getActivePanelContext(state);
  return ctx ? { panelId: ctx.panel.id } : {};
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

/** A diff tab, ready to send: one leaf, marked as a diff in the tree. */
function diffTab(paneId: string): Tab {
  return {
    id: newTabId(),
    title: "Diff",
    rootNode: { type: "leaf", paneId, contentType: "diff" },
    focusedPaneId: paneId,
  };
}

/** The workspace's diff pane, wherever it is — there is at most one. */
function findDiffPane(
  state: AppState,
): { paneId: string; tabId: string } | null {
  const ctx = getActiveLayoutContext(state);
  if (!ctx) return null;
  for (const panel of Object.values(ctx.layout.panels)) {
    for (const tab of panel.tabs) {
      for (const paneId of allPaneIds(tab.rootNode)) {
        if (state.paneContentType[paneId] === "diff") {
          return { paneId, tabId: tab.id };
        }
      }
    }
  }
  return null;
}

/**
 * Put this window's attention on a pane: its panel active, its tab selected,
 * the pane focused. Viewport, so it is written straight into the replica and
 * no command goes anywhere (ADR-179 D3; ticket 4 gives it its own slice).
 */
function focusPaneLocally(
  state: AppState,
  path: string,
  paneId: string,
): Partial<AppState> {
  const layout = state.workspaceLayouts[path];
  if (!layout) return {};
  for (const [panelId, panel] of Object.entries(layout.panels)) {
    const tab = panel.tabs.find((t) => hasPaneId(t.rootNode, paneId));
    if (!tab) continue;
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
              tabs: panel.tabs.map((t) =>
                t.id === tab.id ? { ...t, focusedPaneId: paneId } : t,
              ),
            },
          },
        },
      },
    };
  }
  return {};
}

/** A viewport-only patch: the panel the user is looking at, in one workspace. */
function updateActivePanel(
  state: AppState,
  updater: (panel: Panel) => Panel,
): Partial<AppState> {
  const ctx = getActivePanelContext(state);
  if (!ctx) return {};
  return updatePanel(state, ctx.path, ctx.layout, ctx.panel.id, updater);
}

// ── Layout, owned by the Manor server (ADR-179 D1) ──
//
// A renderer never writes structure. An action resolves what "current" means
// from its own viewport, mints the ids its change needs, and sends one
// `LayoutCommand`; the server runs the reducer, ends the sessions the change
// orphaned, persists, and broadcasts the whole workspace back. That broadcast
// — the sender's own included — is the only thing that writes
// `workspaceLayouts`, in `applyLayoutChanged` below. There is no optimistic
// apply and no second reducer, which is what makes two renderers of one host
// impossible to desynchronise rather than merely unlikely to.
//
// One exception, for one more ticket: the *viewport* fields
// (`panels[].selectedTabId`, `tabs[].focusedPaneId`, `activePanelId`) still
// live inside the structural types, so the actions that only move this
// window's attention write them into the replica directly, and
// `reconcileViewport` carries them across a broadcast. ADR-179 ticket 4 moves
// them into a slice of their own and this paragraph goes with it.

/**
 * Send one command for one workspace, and forget it.
 *
 * Nothing waits for the answer: the answer is a version number, and what the
 * caller actually wants — the new layout — arrives at every renderer at once
 * on `layout.changed`. A command naming an id the server does not have is a
 * no-op there, not an error, so the only thing worth reporting here is a
 * transport failure.
 */
function sendLayoutCommand(
  workspacePath: string,
  command: LayoutCommand,
): void {
  const applied = window.electronAPI?.layout?.apply(workspacePath, command);
  void applied
    ?.then((result) => {
      if (result && "error" in result) {
        console.error(`[layout] ${command.type} refused:`, result.error);
      }
    })
    .catch((err: unknown) => {
      console.error(`[layout] ${command.type} failed:`, err);
    });
}

/** Every pane of one tab, as a set. */
function tabPaneIds(tab: Tab): Set<string> {
  return new Set(allPaneIds(tab.rootNode));
}

function sameMembers(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Keep this window's selection across a broadcast (ADR-179 D3, until ticket 4).
 *
 * The server's copy of the focus fields is whatever the last *command* left
 * there, which is not what this window is looking at: selecting a tab or
 * focusing a pane is viewport, sends nothing, and so never reaches the
 * server. Replacing the replica wholesale would therefore yank the user back
 * to some other renderer's tab on every split.
 *
 * So the local value wins — unless the change that just landed is one that
 * moves the selection on purpose. That is decided structurally, with no
 * memory of who sent what: a panel whose tab set changed (a tab opened,
 * closed or moved) takes the server's selected tab, as does a panel whose
 * selected tab just gained or lost panes; a tab whose pane set changed (a
 * split, a close) takes the server's focused pane. Everything else keeps what
 * this window had, and anything naming an id that no longer exists falls back
 * to the server's.
 */
function reconcileViewport(
  next: WorkspaceLayout,
  local: WorkspaceLayout | undefined,
): WorkspaceLayout {
  if (!local) return next;

  const panels: Record<string, Panel> = {};
  for (const [panelId, nextPanel] of Object.entries(next.panels)) {
    const localPanel = local.panels[panelId];
    const tabs = nextPanel.tabs.map((nextTab) => {
      const localTab = localPanel?.tabs.find((t) => t.id === nextTab.id);
      if (!localTab) return nextTab;
      const keepFocus =
        sameMembers(tabPaneIds(localTab), tabPaneIds(nextTab)) &&
        hasPaneId(nextTab.rootNode, localTab.focusedPaneId);
      return keepFocus
        ? { ...nextTab, focusedPaneId: localTab.focusedPaneId }
        : nextTab;
    });

    const sameTabs =
      localPanel !== undefined &&
      sameMembers(
        new Set(localPanel.tabs.map((t) => t.id)),
        new Set(nextPanel.tabs.map((t) => t.id)),
      );
    const serverTab = nextPanel.tabs.find(
      (t) => t.id === nextPanel.selectedTabId,
    );
    const localOfServerTab = localPanel?.tabs.find(
      (t) => t.id === nextPanel.selectedTabId,
    );
    // Something landed *in* the tab the server points at — a tab dropped onto
    // its pane tree, say. That is a change worth following.
    const serverTabGrew =
      serverTab !== undefined &&
      localOfServerTab !== undefined &&
      !sameMembers(tabPaneIds(localOfServerTab), tabPaneIds(serverTab));
    const keepSelection =
      sameTabs &&
      !serverTabGrew &&
      nextPanel.tabs.some((t) => t.id === localPanel.selectedTabId);

    panels[panelId] = {
      ...nextPanel,
      tabs,
      ...(keepSelection && { selectedTabId: localPanel.selectedTabId }),
    };
  }

  const samePanels = sameMembers(
    new Set(Object.keys(local.panels)),
    new Set(Object.keys(next.panels)),
  );
  const activePanelId =
    samePanels && panels[local.activePanelId]
      ? local.activePanelId
      : next.activePanelId;

  return { ...next, panels, activePanelId };
}

/** Every pane the layout renders, across every panel and tab. */
function layoutPaneIds(layout: WorkspaceLayout): Set<string> {
  const ids = new Set<string>();
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) {
      for (const paneId of allPaneIds(tab.rootNode)) ids.add(paneId);
    }
  }
  return ids;
}

/**
 * What the leaves say about their panes — the half of a pane's state that
 * lives in the tree, and therefore arrives with every broadcast.
 */
function leafSideMaps(layout: WorkspaceLayout): {
  contentTypes: Record<string, "terminal" | "browser" | "diff">;
  urls: Record<string, string>;
} {
  const contentTypes: Record<string, "terminal" | "browser" | "diff"> = {};
  const urls: Record<string, string> = {};
  const walk = (node: PaneNode): void => {
    if (node.type === "leaf") {
      if (node.contentType) contentTypes[node.paneId] = node.contentType;
      if (node.url) urls[node.paneId] = node.url;
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) walk(tab.rootNode);
  }
  return { contentTypes, urls };
}

/**
 * Workspaces whose removal is in flight (`removeWorkspaceLayout`).
 *
 * Removing a worktree closes its panels first, so the sessions inside them
 * end; each of those closes broadcasts, and without this the workspace would
 * be re-adopted here a moment before the server forgot it.
 */
const removingWorkspaces = new Set<string>();

/**
 * The server changed a workspace. Replace the replica with what it sent.
 *
 * A broadcast at or below the version already held is dropped: replays and
 * the overlap between `layout.getAll()` and the first broadcast after it are
 * both normal, and neither has anything new to say.
 */
function applyLayoutChanged(payload: LayoutChangedPayload): void {
  const { workspacePath, version, layout } = payload;
  if (removingWorkspaces.has(workspacePath)) return;
  useAppStore.setState((state) => {
    if (version <= (state.layoutVersions[workspacePath] ?? 0)) return {};
    const local = state.workspaceLayouts[workspacePath];
    const seen = {
      serverLayouts: { ...state.serverLayouts, [workspacePath]: layout },
      layoutVersions: { ...state.layoutVersions, [workspacePath]: version },
    };
    // A workspace this window has never opened stays unopened: its panes
    // would otherwise mount — and spawn shells — behind the user's back.
    if (!local && workspacePath !== state.activeWorkspacePath) return seen;

    const merged = reconcileViewport(layout, local);
    const patch: Partial<AppState> = {
      ...seen,
      workspaceLayouts: { ...state.workspaceLayouts, [workspacePath]: merged },
    };

    const { contentTypes, urls } = leafSideMaps(merged);
    Object.assign(patch, {
      paneContentType: { ...state.paneContentType, ...contentTypes },
      paneUrl: { ...state.paneUrl, ...urls },
    });

    // Panes that left the tree take their side-map entries with them. The
    // server has already ended their sessions (`effects.killPanes`).
    if (local) {
      const alive = layoutPaneIds(merged);
      const gone = [...layoutPaneIds(local)].filter((id) => !alive.has(id));
      if (gone.length > 0) {
        const paneCwd = { ...state.paneCwd };
        const paneTitle = { ...state.paneTitle };
        const paneAgentStatus = { ...state.paneAgentStatus };
        const paneContentType = { ...patch.paneContentType };
        const paneUrl = { ...patch.paneUrl };
        const paneFavicon = { ...state.paneFavicon };
        const panePickedElement = { ...state.panePickedElement };
        const pendingPaneCommands = { ...state.pendingPaneCommands };
        for (const paneId of gone) {
          delete paneCwd[paneId];
          delete paneTitle[paneId];
          delete paneAgentStatus[paneId];
          delete paneContentType[paneId];
          delete paneUrl[paneId];
          delete paneFavicon[paneId];
          delete panePickedElement[paneId];
          delete pendingPaneCommands[paneId];
        }
        Object.assign(patch, {
          paneCwd,
          paneTitle,
          paneAgentStatus,
          paneContentType,
          paneUrl,
          paneFavicon,
          panePickedElement,
          pendingPaneCommands,
        });
      }
    }

    return patch;
  });
}

/**
 * The workspace/surface that was active when the layout last changed — the
 * surface the boot sequence restores (including Home's `HOME_PATH`).
 *
 * Read from the server by `loadPersistedLayout`; null until it resolves, and
 * null when nothing has ever been persisted. Viewport, strictly speaking, and
 * ADR-179 ticket 4 moves it into the per-renderer viewport file.
 */
let lastActiveWorkspacePath: string | null = null;

export function getPersistedActiveWorkspacePath(): string | null {
  return lastActiveWorkspacePath;
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaceLayouts: {},
  layoutVersions: {},
  serverLayouts: {},
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
  pendingStartupCommands: {},
  pendingPaneCommands: {},
  pendingCloseConfirmPaneId: null,
  pendingCloseConfirmTabId: null,
  worktreeSetupState: {},

  loadPersistedLayout: async () => {
    try {
      const api = window.electronAPI;
      const [entries, lastActive] = await Promise.all([
        api?.layout.getAll() ?? {},
        api?.layout.getLastActive() ?? null,
      ]);
      lastActiveWorkspacePath = lastActive;

      // Every workspace's version lands now; its *layout* lands when the
      // workspace is first opened (`setActiveWorkspace`). Adopting them all
      // here would mount every pane of every workspace at boot, and each
      // mount creates a PTY.
      const versions: Record<string, number> = {};
      const cwds: Record<string, string> = {};
      const titles: Record<string, string> = {};
      const agents: Record<string, AgentState> = {};
      const contentTypes: Record<string, "terminal" | "browser" | "diff"> = {};
      const urls: Record<string, string> = {};

      const fromServer: Record<string, WorkspaceLayout> = {};
      for (const [workspacePath, entry] of Object.entries(entries)) {
        versions[workspacePath] = entry.version;
        fromServer[workspacePath] = entry.layout;
        // What the server derived from the PTY events it forwards (D3): the
        // cwd a restored pane reopens in, the title its tab shows.
        for (const [paneId, session] of Object.entries(entry.paneSessions)) {
          if (session.lastCwd) cwds[paneId] = session.lastCwd;
          if (session.lastTitle) titles[paneId] = session.lastTitle;
          const agent = session.lastAgentStatus;
          if (agent && !(agent.status === "idle" && agent.kind === null)) {
            agents[paneId] = agent as AgentState;
          }
        }
        const leaves = leafSideMaps(entry.layout);
        Object.assign(contentTypes, leaves.contentTypes);
        Object.assign(urls, leaves.urls);
      }

      set((state) => ({
        layoutLoaded: true,
        layoutVersions: { ...state.layoutVersions, ...versions },
        serverLayouts: { ...state.serverLayouts, ...fromServer },
        paneCwd: { ...state.paneCwd, ...cwds },
        paneTitle: { ...state.paneTitle, ...titles },
        paneAgentStatus: { ...state.paneAgentStatus, ...agents },
        paneContentType: { ...state.paneContentType, ...contentTypes },
        paneUrl: { ...state.paneUrl, ...urls },
      }));
    } catch (err) {
      console.error("[layout] failed to read the layout:", err);
      set({ layoutLoaded: true });
    }
  },

  setActiveWorkspace: (path: string) =>
    set((state) => {
      if (state.workspaceLayouts[path]) {
        return { activeWorkspacePath: path };
      }
      // First visit: adopt what the server already holds for it. A workspace
      // the server has never heard of gets no layout at all — the empty state
      // renders, and the first command (`new-tab`) creates the panel there.
      const server = state.serverLayouts[path];
      const hasTabs =
        server !== undefined &&
        Object.values(server.panels).some((p) => p.tabs.length > 0);
      if (!hasTabs) return { activeWorkspacePath: path };
      return {
        activeWorkspacePath: path,
        workspaceLayouts: { ...state.workspaceLayouts, [path]: server },
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
    const path = get().activeWorkspacePath;
    if (!path) return null;
    const tab = createTab(undefined, adoptPaneId);
    sendLayoutCommand(path, { type: "new-tab", tab, ...activePanelOf(get()) });
    return { tabId: tab.id, paneId: tab.focusedPaneId };
  },

  addTerminalTab: (command: string) => {
    const path = get().activeWorkspacePath;
    if (!path) return null;
    const tab = createTab();
    const tabPaneId = tab.focusedPaneId;
    // The pane's own state first, the command second: the pane mounts when
    // the broadcast lands, and it reads these on the way up.
    set((state) => ({
      pendingPaneCommands: {
        ...state.pendingPaneCommands,
        [tabPaneId]: command,
      },
    }));
    sendLayoutCommand(path, { type: "new-tab", tab, ...activePanelOf(get()) });
    return { tabId: tab.id, paneId: tabPaneId };
  },

  addBrowserTab: (url: string, opts?: { background?: boolean }) => {
    const path = get().activeWorkspacePath;
    if (!path) return null;
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
    // The pane's own state first: the broadcast brings the leaf back with the
    // same url, but the webview mounts from these maps and must not wait a
    // round trip to know what it is.
    set((state) => ({
      paneContentType: { ...state.paneContentType, [paneId]: "browser" },
      paneUrl: { ...state.paneUrl, [paneId]: url },
    }));
    sendLayoutCommand(path, {
      type: "new-tab",
      tab,
      ...activePanelOf(get()),
      select: !(opts?.background ?? false),
    });
    return { tabId: tab.id, paneId };
  },

  addDiffTab: () => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    const paneId = newPaneId();
    const tab: Tab = {
      id: newTabId(),
      title: "Diff",
      rootNode: { type: "leaf", paneId, contentType: "diff" },
      focusedPaneId: paneId,
    };
    set((state) => ({
      paneContentType: { ...state.paneContentType, [paneId]: "diff" },
    }));
    sendLayoutCommand(path, { type: "new-tab", tab, ...activePanelOf(get()) });
  },

  duplicateTab: (tabId: string) => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return null;
    const layout = state.workspaceLayouts[path];
    if (!layout) return null;
    const found = findPanelWithTab(layout, tabId);
    if (!found) return null;
    const sourceTab = found.tab;

    // Every pane of the source gets a fresh id: a duplicated tab is a second
    // set of sessions, not a second view of the first.
    const { tree: clonedRoot, idMap } = clonePaneTree(
      sourceTab.rootNode,
      newPaneId,
    );
    const newTab: Tab = {
      id: newTabId(),
      title: sourceTab.title,
      rootNode: clonedRoot,
      focusedPaneId:
        idMap[sourceTab.focusedPaneId] ?? allPaneIds(clonedRoot)[0],
    };
    set((s) => {
      const paneContentType = { ...s.paneContentType };
      const paneUrl = { ...s.paneUrl };
      for (const [oldId, newId] of Object.entries(idMap)) {
        const contentType = s.paneContentType[oldId];
        if (contentType) paneContentType[newId] = contentType;
        const url = s.paneUrl[oldId];
        if (url !== undefined) paneUrl[newId] = url;
      }
      return { paneContentType, paneUrl };
    });
    sendLayoutCommand(path, { type: "duplicate-tab", tabId, newTab });
    return newTab.id;
  },

  openOrFocusDiff: () => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return null;
    const existing = findDiffPane(state);
    // Already open somewhere — this is a viewport move, not a layout change.
    if (existing) {
      set(focusPaneLocally(state, path, existing.paneId));
      return existing.tabId;
    }
    const paneId = newPaneId();
    const tab = diffTab(paneId);
    set((s) => ({
      paneContentType: { ...s.paneContentType, [paneId]: "diff" },
    }));
    sendLayoutCommand(path, {
      type: "new-tab",
      tab,
      ...activePanelOf(state),
    });
    return tab.id;
  },

  openDiffInNewPanel: () => {
    const state = get();
    const path = state.activeWorkspacePath;
    if (!path) return;
    const existing = findDiffPane(state);
    if (existing) {
      set(focusPaneLocally(state, path, existing.paneId));
      return;
    }
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const paneId = newPaneId();
    set((s) => ({
      paneContentType: { ...s.paneContentType, [paneId]: "diff" },
    }));
    // Not `new-tab` + `split-panel`: that would move the panel's selected tab
    // into the new panel. The diff opens *beside* what is already there.
    sendLayoutCommand(path, {
      type: "split-panel-with-new-tab",
      tab: diffTab(paneId),
      direction: "horizontal",
      newPanelId: newPanelId(),
      sourcePanelId: ctx.panel.id,
    });
  },

  // Closing ends sessions, and the server is what ends them: the command
  // carries the intent, `effects.killPanes` carries it out. Nothing here
  // touches a PTY, and the confirmation dialogs stay in front of the send
  // (`requestCloseTab`, `requestClosePaneById`).
  closeTab: (tabId: string) => {
    const path = get().activeWorkspacePath;
    if (path) sendLayoutCommand(path, { type: "close-tab", tabId });
  },

  closeOtherTabs: (tabId: string) => {
    const path = get().activeWorkspacePath;
    if (path) sendLayoutCommand(path, { type: "close-other-tabs", tabId });
  },

  closeTabsToRight: (tabId: string) => {
    const path = get().activeWorkspacePath;
    if (path) sendLayoutCommand(path, { type: "close-tabs-to-right", tabId });
  },

  // ── Viewport (ADR-179 D3) ──
  //
  // Selecting a tab, focusing a pane, activating a panel: what *this* window
  // is looking at. No command goes out — the server has no answer to "which
  // window?" — so these write the replica directly, and `reconcileViewport`
  // keeps them across the next broadcast. Ticket 4 moves them to a slice of
  // their own and out of the layout entirely.
  selectTab: (tabId: string) =>
    set((state) =>
      updateActivePanel(state, (p) => ({ ...p, selectedTabId: tabId })),
    ),

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

  reorderTabs: (tabIds: string[]) => {
    const state = get();
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    sendLayoutCommand(ctx.path, {
      type: "reorder-tabs",
      panelId: ctx.panel.id,
      tabIds,
    });
  },

  togglePinTab: (tabId: string) => {
    const path = get().activeWorkspacePath;
    if (path) sendLayoutCommand(path, { type: "toggle-pin-tab", tabId });
  },

  // "Split the focused pane" is resolved here, from this window's viewport:
  // the command names a pane id, and the server never asks what anyone is
  // looking at (ADR-179 D1).
  splitPane: (direction: SplitDirection) => {
    const ctx = getActivePanelContext(get());
    if (!ctx) return;
    const tab = ctx.panel.tabs.find((t) => t.id === ctx.panel.selectedTabId);
    if (!tab) return;
    sendLayoutCommand(ctx.path, {
      type: "split-pane",
      paneId: tab.focusedPaneId,
      direction,
      newPaneId: newPaneId(),
    });
  },

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
    const ctx = getActiveLayoutContext(state);
    // Checked against this window's replica so the caller hears "no such
    // pane" now rather than nothing at all: on the server an unknown id is a
    // silent no-op, and `splitPaneAt` answers with the id it minted.
    if (!ctx || !findPanelWithPane(ctx.layout, targetPaneId)) return null;
    const newPane = newPaneId();
    const { contentType, paneCommand, url } = opts ?? {};
    // "agent" panes are terminals that auto-run a command -- don't persist as
    // a content type.
    const treeContentType = contentType === "agent" ? undefined : contentType;
    set((s) => ({
      ...(treeContentType && {
        paneContentType: { ...s.paneContentType, [newPane]: treeContentType },
      }),
      ...(url && { paneUrl: { ...s.paneUrl, [newPane]: url } }),
      ...(paneCommand && {
        pendingPaneCommands: {
          ...s.pendingPaneCommands,
          [newPane]: paneCommand,
        },
      }),
    }));
    sendLayoutCommand(ctx.path, {
      type: "split-pane-at",
      paneId: targetPaneId,
      direction,
      position,
      newPaneId: newPane,
      contentType: treeContentType,
      url,
    });
    return newPane;
  },

  movePaneToTarget: (
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    sendLayoutCommand(path, {
      type: "move-pane",
      sourcePaneId,
      targetPaneId,
      direction,
      position,
      // Emptying the last panel would leave the workspace with nowhere to put
      // anything; the reducer seeds it with this instead.
      fallbackTab: createTab(),
    });
  },

  moveTabToPane: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    sendLayoutCommand(path, {
      type: "move-tab-to-pane",
      tabId,
      targetPaneId,
      direction,
      position,
      fallbackTab: createTab(),
    });
  },

  extractPaneToTab: (paneId: string, targetPanelId?: string) => {
    const state = get();
    const ctx = getActiveLayoutContext(state);
    if (!ctx) return null;
    const found = findPanelWithPane(ctx.layout, paneId);
    if (!found) return null;
    // A pane that is already its tab's only leaf keeps its tab; anything else
    // moves into a tab minted here. Either way the answer is known before the
    // command is sent, which is what lets this stay synchronous.
    const sole =
      found.tab.rootNode.type === "leaf" &&
      found.tab.rootNode.paneId === paneId;
    const mintedTabId = newTabId();
    sendLayoutCommand(ctx.path, {
      type: "extract-pane-to-tab",
      paneId,
      targetPanelId,
      newTabId: mintedTabId,
      fallbackTab: createTab(),
    });
    return sole ? found.tab.id : mintedTabId;
  },

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
    const state = get();
    const ctx = getActiveLayoutContext(state);
    // A pane the replica no longer holds has already been closed — by this
    // window a moment ago, or by another renderer. Its `pty.onExit` arrives
    // here too, and must not abandon its agent a second time.
    if (!ctx || !findPanelWithPane(ctx.layout, paneId)) return;
    window.electronAPI.agents
      .abandonForPane(paneId, state.paneTitle[paneId] ?? null)
      .catch(console.error);
    sendLayoutCommand(ctx.path, { type: "close-pane", paneId });
  },

  /**
   * Put back the last thing closed in this workspace.
   *
   * The stack is the server's (ADR-179 D3), so this sends the command and
   * lets the broadcast say what came back. Only the two viewport defaults are
   * resolved here: which panel to restore into when the original is gone, and
   * a tab id to mint if the original tab went too.
   */
  reopenClosedPane: () => {
    const ctx = getActivePanelContext(get());
    if (!ctx) return;
    sendLayoutCommand(ctx.path, {
      type: "reopen-closed-pane",
      newTabId: newTabId(),
      panelId: ctx.panel.id,
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

  // Any pane, in any panel — the same scope `list_panes` and `movePaneToTarget`
  // use, not just the active panel's.
  focusPane: (paneId: string) =>
    set((state) => {
      const path = state.activeWorkspacePath;
      if (!path) return state;
      return focusPaneLocally(state, path, paneId);
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

  /**
   * A pane's title, from an OSC sequence or an MCP call.
   *
   * Written here *and* sent: the map is what this window renders now, and the
   * command is what reaches the server's `paneSessions` and so the file
   * (ADR-179 D3). `set-pane-title` changes no tree, so no broadcast follows
   * it and the local write is not a duplicate of one.
   */
  setPaneTitle: (paneId: string, title: string) => {
    const state = get();
    if (state.paneTitle[paneId] === title) return;
    set({ paneTitle: { ...state.paneTitle, [paneId]: title } });
    if (state.activeWorkspacePath) {
      sendLayoutCommand(state.activeWorkspacePath, {
        type: "set-pane-title",
        paneId,
        title,
      });
    }
  },

  clearPaneTitle: (paneId: string) => {
    const state = get();
    if (!(paneId in state.paneTitle)) return;
    const { [paneId]: _, ...rest } = state.paneTitle;
    set({ paneTitle: rest });
    if (state.activeWorkspacePath) {
      sendLayoutCommand(state.activeWorkspacePath, {
        type: "set-pane-title",
        paneId,
        title: null,
      });
    }
  },

  setPaneTitleFromStream: (paneId: string, title: string | null) =>
    set((state) => {
      if (title === null) {
        if (!(paneId in state.paneTitle)) return state;
        const { [paneId]: _, ...rest } = state.paneTitle;
        return { paneTitle: rest };
      }
      if (state.paneTitle[paneId] === title) return state;
      return { paneTitle: { ...state.paneTitle, [paneId]: title } };
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

  /**
   * Where a browser pane is, after it navigated.
   *
   * The map is this window's; the leaf's `url` is the layout's, and it is
   * what makes the pane come back on the same page after a relaunch — so the
   * same fact goes out as a command. Only for a pane the tree calls a
   * browser: `set-pane-content-type` is what carries a url, and sending it
   * for a terminal would retype the pane.
   */
  setPaneUrl: (paneId: string, url: string) => {
    const state = get();
    if (state.paneUrl[paneId] === url) return;
    set({ paneUrl: { ...state.paneUrl, [paneId]: url } });
    const ctx = getActiveLayoutContext(state);
    if (!ctx || state.paneContentType[paneId] !== "browser") return;
    if (!findPanelWithPane(ctx.layout, paneId)) return;
    sendLayoutCommand(ctx.path, {
      type: "set-pane-content-type",
      paneId,
      contentType: "browser",
      url,
    });
  },

  setPaneContentType: (
    paneId: string,
    contentType: "terminal" | "browser" | "diff",
  ) => {
    const state = get();
    if (state.paneContentType[paneId] === contentType) return;
    // "terminal" is the implicit default — the map holds only the exceptions.
    const paneContentType = { ...state.paneContentType };
    if (contentType === "terminal") delete paneContentType[paneId];
    else paneContentType[paneId] = contentType;
    set({ paneContentType });
    // The leaf carries the type too, so the pane comes back as itself.
    if (state.activeWorkspacePath) {
      sendLayoutCommand(state.activeWorkspacePath, {
        type: "set-pane-content-type",
        paneId,
        contentType,
      });
    }
  },

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

  /**
   * Forget a workspace whose worktree is going away.
   *
   * Two things have to happen and they are not the same thing: the sessions
   * inside it must end, which only the server can do, and the workspace must
   * leave the file. So every panel is closed by command first —
   * `effects.killPanes` ends the terminals — and only then is the workspace
   * removed. The replica is dropped here and now, because the user is already
   * looking at somewhere else and its panes must unmount.
   */
  removeWorkspaceLayout: (workspacePath: string) => {
    const layout = get().workspaceLayouts[workspacePath];
    const panelIds = Object.keys(layout?.panels ?? {});

    set((state) => {
      const { [workspacePath]: removed, ...workspaceLayouts } =
        state.workspaceLayouts;
      const { [workspacePath]: _version, ...layoutVersions } =
        state.layoutVersions;
      const { [workspacePath]: _server, ...serverLayouts } = state.serverLayouts;
      if (!removed) return { workspaceLayouts, layoutVersions, serverLayouts };

      const paneCwd = { ...state.paneCwd };
      const paneTitle = { ...state.paneTitle };
      const paneAgentStatus = { ...state.paneAgentStatus };
      const paneContentType = { ...state.paneContentType };
      const paneUrl = { ...state.paneUrl };
      const pendingPaneCommands = { ...state.pendingPaneCommands };
      for (const paneId of layoutPaneIds(removed)) {
        delete paneCwd[paneId];
        delete paneTitle[paneId];
        delete paneAgentStatus[paneId];
        delete paneContentType[paneId];
        delete paneUrl[paneId];
        delete pendingPaneCommands[paneId];
      }
      return {
        workspaceLayouts,
        layoutVersions,
        serverLayouts,
        paneCwd,
        paneTitle,
        paneAgentStatus,
        paneContentType,
        paneUrl,
        pendingPaneCommands,
      };
    });

    const api = window.electronAPI;
    if (!api) return;
    // Held until the removal lands, so the closes on the way out are not
    // mistaken for a workspace worth re-adopting.
    removingWorkspaces.add(workspacePath);
    void (async () => {
      try {
        for (const panelId of panelIds) {
          await api.layout.apply(workspacePath, {
            type: "close-panel",
            panelId,
          });
        }
        await api.layout.remove(workspacePath);
      } catch (err) {
        console.error(`[layout] failed to remove ${workspacePath}:`, err);
      } finally {
        removingWorkspaces.delete(workspacePath);
      }
    })();
  },

  // ── Panel operations ──

  splitPanel: (direction: SplitDirection) => {
    const ctx = getActivePanelContext(get());
    if (!ctx) return;
    sendLayoutCommand(ctx.path, {
      type: "split-panel",
      panelId: ctx.panel.id,
      direction,
      newPanelId: newPanelId(),
      // The selected tab moves into the new panel; if that empties the
      // source panel, it gets a fresh terminal rather than nothing.
      tabId: ctx.panel.selectedTabId,
      fallbackTab: createTab(),
    });
  },

  closePanel: (panelId: string) => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    sendLayoutCommand(path, {
      type: "close-panel",
      panelId,
      fallbackPanelId: newPanelId(),
    });
  },

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

  updatePanelSplitRatio: (firstPanelId: string, ratio: number) => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    sendLayoutCommand(path, {
      type: "update-panel-ratio",
      firstPanelId,
      ratio,
    });
  },

  moveTabToPanel: (tabId: string, targetPanelId: string) => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    sendLayoutCommand(path, {
      type: "move-tab-to-panel",
      tabId,
      targetPanelId,
    });
  },

  splitPanelWithTab: (
    tabId: string,
    targetPanelId: string,
    direction: SplitDirection,
  ) => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    sendLayoutCommand(path, {
      type: "split-panel-with-tab",
      tabId,
      targetPanelId,
      direction,
      newPanelId: newPanelId(),
      fallbackTab: createTab(),
    });
  },

  // A tab dropped onto another tab stops being a tab: its whole pane subtree
  // becomes one side of a split of the target's. No ids are minted — the
  // panes it already has come along.
  mergeTabIntoTab: (sourceTabId: string, targetTabId: string) => {
    const path = get().activeWorkspacePath;
    if (!path || sourceTabId === targetTabId) return;
    sendLayoutCommand(path, {
      type: "merge-tab-into-tab",
      sourceTabId,
      targetTabId,
      fallbackTab: createTab(),
    });
  },

  updateSplitRatio: (firstPaneId: string, ratio: number) => {
    const path = get().activeWorkspacePath;
    if (!path) return;
    sendLayoutCommand(path, {
      type: "update-split-ratio",
      firstPaneId,
      ratio,
    });
  },

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

// ── The server's broadcasts land here (ADR-179 D1) ──
//
// Installed at import time, which is before anything can call
// `loadPersistedLayout`: a change that happens between the read and its
// resolution is delivered, and the version guard drops it if the read already
// had it.
//
// Detached windows (ADR-156) are the one exception. They share a
// `workspacePath` with the primary while holding a single handed-off tab, so
// a broadcast for that workspace would replace their whole layout with the
// primary's. ADR-179 ticket 6 makes a detached window a *claim* on a tab of
// the shared layout and this exception goes with it.
if (!window.electronAPI?.isDetached) {
  window.electronAPI?.layout?.onChanged?.(applyLayoutChanged);
}
