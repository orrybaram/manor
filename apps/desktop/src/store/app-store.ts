import type { NewAgentTarget } from "../components/phone/NewAgent/new-agent-target";
import { useMemo } from "react";
import { create } from "zustand";
import {
  type PaneNode,
  type SplitDirection,
  allPaneIds,
  hasPaneId,
  nextPaneId,
  prevPaneId,
} from "../lib/layout/pane-tree";
import {
  type PanelNode,
  allPanelIds,
  nextPanelId,
  prevPanelId,
} from "../lib/layout/panel-tree";
import {
  type PaneContentType,
  type PaneLeaf,
  type Panel,
  type Tab,
  type WorkspaceLayout,
  findPanelWithPane,
  findPanelWithTab,
  layoutLeaves,
  layoutPaneIds,
} from "../lib/layout/workspace-layout";
import { applyLayoutCommand, type LayoutCommand } from "../lib/layout/commands";
import { createTab, newPaneId, newPanelId, newTabId } from "../lib/layout/ids";
import {
  cloneTabWithFreshIds,
  createBrowserTab,
  createDiffTab,
  createFileTab,
  findDiffPane as findDiffPaneIn,
} from "../lib/layout/tab-builders";
import {
  type WorkspaceViewport,
  EMPTY_VIEWPORT,
  applyHint,
  reconcileViewport,
} from "../lib/layout/viewport";
import {
  type LayoutClaim,
  type RendererPlatform,
  type Visibility,
  holdsClaim,
  isTabVisible,
  visibleTabsFor,
} from "../lib/layout/visible-tabs";
import { BridgeUnavailableError } from "../bridge/client";
import { provideHostLookups } from "../bridge/host-lookups";
import { handleBridgeUnavailable } from "../lib/bridge-unavailable-toast";
import type {
  LayoutChangedPayload,
  LayoutEntry,
  PaneAgentStatus,
  PaneAgentStatusUpdate,
  PersistedViewportFile,
  PickedElementResult,
} from "../electron.d";
import type { SetupStep, StepStatus } from "./project-store";
import type { Location } from "./navigation-history-store";
import { isHomePath } from "../lib/home-path";
import { LOCAL_HOST_ID, type HostId } from "../lib/hosts";
import type { TaskProvider } from "../lib/tasks";
import { hostForPath } from "../lib/workspace-directory";
import {
  parseWorkspaceKey,
  workspaceKey,
  type WorkspaceKey,
} from "../lib/workspace-key";
import { useProjectStore } from "./project-store";
import { bootAndResync } from "../bridge/resync";
import { ipcErrorMessage } from "../lib/ipc-error";
import { useRemotePaneStore } from "./remote-pane-store";
import { hasUnsavedEdits } from "./open-file-store";
import { closeOverLostTab, guardClosingPanes } from "./unsaved-guard-store";
import {
  type SnapshotResult,
  adoptLayout,
  applyLayoutSnapshot,
  sessionSideMaps,
  withoutWorkspace,
} from "./layout-snapshot";

export type { Panel, Tab, WorkspaceLayout };

/**
 * App-level surfaces that can fill the main area. `composer` is the
 * phone new-agent composer; desk never enters it.
 */
export type AppSurface = "workspace" | "tasks" | "composer";

/** Unsent new-agent composer state, kept so a round trip loses nothing. */
type ComposerDraft = { text: string; target: NewAgentTarget | null };

/**
 * What to open the Tasks view on. `project` is a sidebar entry
 * key; `null` = all projects. `clearFilters` drops `provider`'s saved
 * filters (ignored without one), so the view lists exactly what the caller
 * counted.
 */
type TasksIntent = {
  search?: string;
  project?: string | null;
  provider?: TaskProvider;
  clearFilters?: boolean;
};

/**
 * Spread into a `set()` patch by actions that activate a workspace or put a
 * tab/pane in front of the user: they leave the Tasks view (and the phone
 * composer).
 */
const WORKSPACE_SURFACE = { activeSurface: "workspace" } as const;

/** A fresh tab's only pane — the one a caller wants to run a command in. */
function firstPaneOfTab(tab: Tab): string {
  return allPaneIds(tab.rootNode)[0];
}

export interface AppState {
  /**
   * This renderer's replica of the Manor server's layout, for every workspace
   * the server has told it about. Read freely; never written by
   * an action — the writers are `applyLayoutSnapshot` (the boot read and a
   * resync) and `applyLayoutChanged`, which replace a workspace when the
   * server says so.
   *
   * Keyed by the workspace's host-qualified key, as is every other
   * per-workspace map below and the server's own: a local and a remote
   * workspace with the same path each have their own. See
   * `selectActiveWorkspaceKey` and `layoutKeyFor`.
   *
   * What a pane *is* — its content type, its saved url — is read from here
   * too, through `selectPaneContentType` / `selectPaneUrl`.
   */
  workspaceLayouts: Record<string, WorkspaceLayout>;
  /** The server version each replica is at. An older broadcast is dropped. */
  layoutVersions: Record<string, number>;
  /**
   * The workspaces this window has opened, and so renders.
   *
   * Rendering a workspace mounts its panes and mounting a pane creates a PTY,
   * so a workspace is only rendered once it has been visited — and then kept
   * rendered, hidden, so switching back remounts nothing.
   */
  mountedWorkspaces: Record<string, true>;
  /**
   * What *this* renderer is looking at, per workspace.
   *
   * The tab set is shared and the server owns it; the selection is not. Every
   * write here is local — no command goes anywhere — and the whole slice is
   * persisted per renderer (`viewport.json` on the desktop, `localStorage` in
   * a browser) and reported to the host as the workspace's default viewport
   * for renderers that have none.
   */
  viewports: Record<string, WorkspaceViewport>;
  /**
   * Who is holding which tab in a window of its own, per workspace.
   *
   * The server's, like the layout: a detached window reports a claim as part
   * of its viewport and every renderer is told the result. The primary hides
   * the tabs in here, a claiming window shows only its own, and a browser
   * ignores the whole map — see `visible-tabs.ts`.
   */
  claims: Record<string, LayoutClaim[]>;
  /** The active workspace's path (or Home's `HOME_PATH`). */
  activeWorkspacePath: string | null;
  /**
   * The host the active workspace is on; with `activeWorkspacePath` it makes
   * the key of the active layout (`selectActiveWorkspaceKey`).
   */
  activeWorkspaceHostId: HostId;
  /**
   * Which app-level surface fills the main area. `"tasks"` shows
   * the Tasks view over the active workspace, which stays active
   * underneath; anything that activates a workspace or opens a tab flips it
   * back to `"workspace"`. Not persisted.
   */
  activeSurface: AppSurface;
  /**
   * What the Tasks view should open on — one-shot: `TasksView`
   * consumes it via `consumeTasksIntent`. Not part of navigation history.
   */
  tasksIntent: TasksIntent | null;
  paneCwd: Record<string, string>;
  paneTitle: Record<string, string>;
  paneAgentStatus: Record<string, PaneAgentStatus>;
  paneFavicon: Record<string, string>;
  paneAudioPlaying: Record<string, boolean>;
  paneAudioMuted: Record<string, boolean>;
  /** Recording start timestamp (ms epoch) per pane, while capture is live. */
  paneRecordingStartedAt: Record<string, number>;
  /**
   * Where a browser pane's webview is right now, written the moment it
   * navigates. The leaf's `url` catches up a round trip later, when the
   * command `setPaneUrl` sends comes back; until then this is the truth, and
   * a webview whose `src` followed the older leaf would be sent back a page.
   */
  paneLiveUrl: Record<string, string>;
  panePickedElement: Record<string, PickedElementResult>;
  webviewFocusedPaneId: string | null;
  layoutLoaded: boolean;
  /**
   * Why the boot read of the layout failed, if it did. A
   * detached window then shows "Couldn't load this window" instead of its
   * splash forever.
   */
  layoutLoadError: string | null;
  /**
   * The panes of the workspace this window shows at launch, as the layout
   * read at launch has them, whose first `pty.create` has not settled yet.
   * That create is not one the user meant, so it leaves a
   * sleeping host asleep (`wake: false`). `forgetRestoredPane` drops a pane
   * once it has, so every later create wakes as usual. A workspace the user
   * opens later is intent, so its panes are never here.
   */
  restoredPaneIds: ReadonlySet<string>;
  /**
   * The launch has picked the workspace this window shows (the active one):
   * its panes of the layout read at launch become `restoredPaneIds`. Once
   * per launch; any later call does nothing.
   */
  seedRestoredPanes: () => void;
  /** `paneId`'s first create after launch is done, whatever its answer. */
  forgetRestoredPane: (paneId: string) => void;
  /** Pane ID awaiting close confirmation (when agent is active) */
  pendingCloseConfirmPaneId: string | null;
  /** Tab ID awaiting close confirmation (when agent is active in a pane) */
  pendingCloseConfirmTabId: string | null;
  // Workspace activation
  /**
   * Activate workspace `path` on `hostId`. Callers that know the workspace's
   * project pass its host; without one it is the host of the project that
   * has the path (the selected project first, see `layoutKeyFor`).
   */
  setActiveWorkspace: (path: string, hostId?: HostId | null) => void;

  /**
   * Show the Tasks view; leaves the active workspace alone. An
   * `intent` presets its search / project.
   */
  showTasksView: (intent?: TasksIntent) => void;
  /** Show the phone new-agent composer; the workspace stays active. */
  showComposer: () => void;
  /** Leave the composer back to the workspace surface. */
  closeComposer: () => void;
  /** Unsent composer text + chosen target; in-memory only. */
  composerDraft: ComposerDraft;
  setComposerDraft: (patch: Partial<ComposerDraft>) => void;
  clearComposerDraft: () => void;
  /** Return the pending `tasksIntent` and clear it. */
  consumeTasksIntent: () => TasksIntent | null;

  /**
   * Atomically navigate to a specific pane inside a workspace.
   * Sets the active workspace, activePanelId, selectedTabId, and focusedPaneId
   * in a single Zustand set() call so subscribers see no intermediate states.
   * Bails (no state change) if the workspace has no layout or the tabId
   * does not exist in any panel.
   */
  navigateToContext: (ctx: {
    workspaceKey: WorkspaceKey;
    tabId: string;
    paneId: string;
  }) => void;

  // Layout restore — called once on startup
  loadPersistedLayout: () => Promise<void>;

  // Tab operations
  //
  // Every one of these sends a command and returns the ids it minted; the tab
  // itself appears when the server's broadcast lands, a frame later. They answer null only when there is no workspace to put a tab in —
  // a workspace with no *panel* is fine, because the server makes one.
  /**
   * Returns the IDs of the tab it created, or null when there is no active
   * workspace. `adoptPaneId` lets the new pane reuse a PTY session main
   * already prewarmed under that ID; everything else lets the store mint one.
   */
  addTab: (adoptPaneId?: string) => { tabId: string; paneId: string } | null;
  /**
   * A new tab whose terminal runs `command` as soon as its shell is ready.
   * The command is queued on the server, not here, so the
   * pane runs it whichever renderer happens to mount it first. With
   * `submit: false` it is typed but not run ("fix in terminal" — the user
   * reviews it first).
   */
  addTerminalTab: (
    command: string,
    opts?: {
      submit?: boolean;
      kind?: "shell" | "agent-startup";
      /** The agent's first message, delivered through a file on the pane's
       *  host rather than typed into `command`. */
      prompt?: string;
    },
  ) => { tabId: string; paneId: string } | null;
  /**
   * Open a terminal tab running `command` in workspace `key` without
   * switching to it: the workspace is mounted hidden, so the new pane still
   * mounts and its PTY types the command (the Dashboard's background launch).
   */
  addTerminalTabIn: (
    key: WorkspaceKey,
    command: string,
    opts?: { kind?: "shell" | "agent-startup"; prompt?: string },
  ) => { tabId: string; paneId: string };
  addBrowserTab: (
    url: string,
    opts?: { background?: boolean },
  ) => { tabId: string; paneId: string } | null;
  addDiffTab: () => void;
  /**
   * Open a file pane as a new tab of the active panel, on `filePath`
   * (workspace-relative) or with no file open, which shows its tree; or of
   * the panel `at` names, in its workspace, whichever is active. Returns the
   * ids it minted, or null with no workspace.
   */
  addFileTab: (
    filePath?: string,
    at?: { workspaceKey: WorkspaceKey; panelId: string },
  ) => { tabId: string; paneId: string } | null;
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
      contentType?: "terminal" | "browser" | "diff" | "file" | "agent";
      paneCommand?: string;
      url?: string;
      /** A file pane's open file, workspace-relative. */
      filePath?: string;
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
   * the effect would otherwise leave focus where it is.
   */
  paneFocusNonce: number;
  /** Sends keyboard focus back to the focused pane of the active tab. */
  refocusActivePane: () => void;

  // CWD tracking
  setPaneCwd: (paneId: string, cwd: string) => void;

  // Title tracking (from terminal OSC sequences)
  setPaneTitle: (paneId: string, title: string) => void;
  /**
   * A title the host already knows — an OSC title from the PTY stream, or a
   * stale title cleared when a new agent starts in the pane. Local only: the
   * server derives `lastTitle` from the same daemon event, so
   * sending it back would be one `layout.apply` per viewer per title change.
   */
  setPaneTitleFromStream: (paneId: string, title: string | null) => void;

  // Pane content type
  setPaneContentType: (paneId: string, contentType: PaneContentType) => void;
  /** The file a file pane shows, workspace-relative; kept on its leaf. */
  setPaneFilePath: (paneId: string, filePath: string) => void;

  // Browser favicon
  setPaneFavicon: (paneId: string, favicon: string | null) => void;

  // Browser audio state
  setPaneAudioPlaying: (paneId: string, playing: boolean) => void;
  setPaneAudioMuted: (paneId: string, muted: boolean) => void;

  /**
   * Recording state. `startedAt` (not a boolean) so the pane's
   * "Recording" indicator can render elapsed time without a second lookup.
   * Set/cleared from `App.tsx`'s "webview:recording-command" subscription —
   * main owns the recording lifecycle, the renderer just mirrors it. Pass
   * `null` to clear.
   */
  setPaneRecordingStartedAt: (paneId: string, startedAt: number | null) => void;

  // Browser URL tracking
  setPaneUrl: (paneId: string, url: string) => void;

  /**
   * Store the pane's Agent status exactly as the Status reconciler published
   * it — the renderer displays it, it does not re-derive it.
   */
  setPaneAgentStatus: (update: PaneAgentStatusUpdate) => void;

  /**
   * Queue `command` to run in `paneId` once its shell is ready — for a pane
   * that already exists and is about to (re)create its session, e.g. one
   * recovered after its remote host restarted. The queue is the
   * server's: whichever renderer creates the session
   * types it.
   */
  setPendingPaneCommand: (
    paneId: string,
    command: string,
    opts?: { submit?: boolean },
  ) => void;

  // Workspace cleanup
  /** Close every pane of the workspace keyed `key` and drop its layout. */
  removeWorkspaceLayout: (key: WorkspaceKey) => void;
  /**
   * Move this renderer's replica and viewport of the layout keyed `from` to
   * `to` — a workspace whose project moved to another host keeps its tabs.
   * The server moves its own copy (`LayoutStore.moveWorkspaces`)
   * and broadcasts it at `to`. No-op when `to` already has a layout or
   * `from` has none.
   */
  moveWorkspaceLayout: (from: WorkspaceKey, to: WorkspaceKey) => void;

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
      workspacePath?: string;
    }
  >;
  /**
   * The checklist of a workspace being created. Its setup script is not a
   * step: the server runs it in a tab of its own.
   */
  initWorktreeSetup: (wsPathHint: string) => void;
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

}

/**
 * Enough of the store to answer "what is this renderer showing".
 *
 * `claims` is optional so the slices that are built by hand — the menu
 * context sync, the agents list — keep working without knowing about
 * detached windows: no claims means nothing is popped out, which is the
 * truth everywhere but the desktop with a popout open.
 */
type ViewportState = Pick<
  AppState,
  | "workspaceLayouts"
  | "viewports"
  | "activeWorkspacePath"
  | "activeWorkspaceHostId"
> &
  Partial<Pick<AppState, "claims">>;

/**
 * The key of workspace `path` for looking up its layout: on
 * `hostId` when the caller knows it, else on the host of the project that
 * has the path, the selected project first (`hostForPath`). Local when
 * no project has it.
 */
export function layoutKeyFor(path: string, hostId?: HostId | null): WorkspaceKey {
  return workspaceKey(
    hostId ?? hostForPath(useProjectStore.getState(), path) ?? LOCAL_HOST_ID,
    path,
  );
}

/** The key of the active workspace's layout, or null when none is active. */
export function selectActiveWorkspaceKey(
  state: Pick<AppState, "activeWorkspacePath" | "activeWorkspaceHostId">,
): WorkspaceKey | null {
  const path = state.activeWorkspacePath;
  return path ? workspaceKey(state.activeWorkspaceHostId, path) : null;
}

/**
 * The key of the active workspace's layout, or null on Home:
 * Home is the Dashboard and never holds tabs, so every action that resolves
 * its target through this — adding tabs, splits, reopening closed panes — is
 * a no-op there in this one place.
 */
/**
 * First visit: render what the server already holds for `key`. A workspace
 * the server has never heard of has no layout yet — the empty state renders,
 * and the first command (`new-tab`) creates the panel. Empty when it is
 * already mounted.
 */
function mountPatch(state: AppState, key: WorkspaceKey): Partial<AppState> {
  if (state.mountedWorkspaces[key]) return {};
  const layout = state.workspaceLayouts[key];
  return {
    mountedWorkspaces: { ...state.mountedWorkspaces, [key]: true },
    ...(layout && {
      viewports: {
        ...state.viewports,
        [key]: reconcileFor(state, key, layout, viewportOf(state, key)),
      },
    }),
  };
}

function activeLayoutKey(
  state: Pick<AppState, "activeWorkspacePath" | "activeWorkspaceHostId">,
): WorkspaceKey | null {
  if (isHomePath(state.activeWorkspacePath)) return null;
  return selectActiveWorkspaceKey(state);
}

/** The active workspace's layout, or null. */
export function selectActiveLayout(
  state: Pick<
    AppState,
    "activeWorkspacePath" | "activeWorkspaceHostId" | "workspaceLayouts"
  >,
): WorkspaceLayout | null {
  const key = activeLayoutKey(state);
  return (key && state.workspaceLayouts[key]) || null;
}

// Selector for the active workspace's active panel (backward compat: same shape as old WorkspaceTabState)
export function selectActiveWorkspace(state: ViewportState): Panel | null {
  return getActivePanelContext(state)?.panel ?? null;
}

/** The panel this window has the keyboard in, or null. */
export function selectActivePanelId(state: ViewportState): string | null {
  return getActivePanelContext(state)?.panel.id ?? null;
}

/**
 * The tab a panel is showing.
 *
 * Falls back to the panel's first tab rather than to nothing: a workspace
 * whose viewport has not been reconciled yet (a layout adopted this tick, a
 * test that seeded only the structure) still has to render something, and
 * "the first tab" is what `reconcileViewport` would have written anyway.
 */
export function selectSelectedTabId(
  state: ViewportState,
  panelId: string | null | undefined,
  workspacePath?: string | null,
): string | null {
  const path = workspacePath ?? activeLayoutKey(state);
  if (!path || !panelId) return null;
  const panel = state.workspaceLayouts[path]?.panels[panelId];
  if (!panel) return null;
  // Claimed tabs are not candidates: they are on screen in another window,
  // and the fallback below must not hand this one a tab it does not render.
  const visible = panel.tabs.filter((t) => tabVisibleHere(state, path, t.id));
  const chosen = state.viewports?.[path]?.selectedTabIds[panelId];
  if (chosen !== undefined && visible.some((t) => t.id === chosen)) {
    return chosen;
  }
  return visible[0]?.id ?? null;
}

/** The pane a tab focuses, falling back to its first pane. */
export function selectFocusedPaneId(
  state: ViewportState,
  tabId: string | null | undefined,
  workspacePath?: string | null,
): string | null {
  const path = workspacePath ?? activeLayoutKey(state);
  if (!path || !tabId) return null;
  const layout = state.workspaceLayouts[path];
  if (!layout) return null;
  const found = findPanelWithTab(layout, tabId);
  if (!found) return null;
  const chosen = state.viewports?.[path]?.focusedPaneIds[tabId];
  if (chosen !== undefined && hasPaneId(found.tab.rootNode, chosen)) {
    return chosen;
  }
  return allPaneIds(found.tab.rootNode)[0] ?? null;
}

/** The pane the keyboard is in: active panel → selected tab → focused pane. */
export function selectFocusedPaneOfActiveTab(state: AppState): string | null {
  const ctx = getActivePanelContext(state);
  if (!ctx) return null;
  const tabId = selectSelectedTabId(state, ctx.panel.id, ctx.path);
  return selectFocusedPaneId(state, tabId, ctx.path);
}

/** `useActivePanel()` — the panel id this window has the keyboard in. */
export function useActivePanel(workspacePath?: string | null): string | null {
  return useAppStore((state) =>
    workspacePath === undefined
      ? selectActivePanelId(state)
      : workspacePath
        ? activePanelIdOf(state, workspacePath)
        : null,
  );
}

/** `useSelectedTab(panelId)` — the tab that panel is showing. */
export function useSelectedTab(
  panelId: string | null | undefined,
  workspacePath?: string | null,
): string | null {
  return useAppStore((state) =>
    selectSelectedTabId(state, panelId, workspacePath),
  );
}

/** `useFocusedPane(tabId)` — the pane that tab focuses. */
export function useFocusedPane(
  tabId: string | null | undefined,
  workspacePath?: string | null,
): string | null {
  return useAppStore((state) =>
    selectFocusedPaneId(state, tabId, workspacePath),
  );
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
    const tabId = selectSelectedTabId(state, panel.id, ctx.path);
    const tab = panel.tabs.find((t) => t.id === tabId);
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
export function selectVisiblePaneIds(state: ViewportState): ReadonlySet<string> {
  const path = activeLayoutKey(state);
  const layout = path ? state.workspaceLayouts[path] : undefined;
  const viewport = path ? state.viewports?.[path] : undefined;
  const claims = path ? state.claims?.[path] : undefined;
  // Built once per (layout, viewport, claims) however many callers read it,
  // so the same set comes back until one of them changes.
  const cached = visiblePaneIdsCache;
  if (
    cached &&
    cached.layout === layout &&
    cached.viewport === viewport &&
    cached.claims === claims
  ) {
    return cached.ids;
  }
  const ids = new Set<string>();
  if (path && layout) {
    for (const panel of Object.values(layout.panels)) {
      const tabId = selectSelectedTabId(state, panel.id, path);
      const tab = panel.tabs.find((t) => t.id === tabId);
      if (!tab) continue;
      for (const id of allPaneIds(tab.rootNode)) ids.add(id);
    }
  }
  visiblePaneIdsCache = { layout, viewport, claims, ids };
  return ids;
}

let visiblePaneIdsCache: {
  layout: WorkspaceLayout | undefined;
  viewport: WorkspaceViewport | undefined;
  claims: LayoutClaim[] | undefined;
  ids: ReadonlySet<string>;
} | null = null;

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
  if (state.activeSurface === "tasks") {
    return { kind: "surface", surface: "tasks" };
  }
  const key = activeLayoutKey(state);
  if (!key) {
    return { kind: "surface", surface: "home" };
  }
  const ctx = getActivePanelContext(state);
  if (!ctx) {
    return { kind: "surface", surface: "home" };
  }
  return {
    kind: "workspace",
    workspaceKey: ctx.path,
    panelId: ctx.panel.id,
    tabId: selectSelectedTabId(state, ctx.panel.id, ctx.path) ?? "",
  };
}

/** This window's viewport for a workspace; empty rather than absent. */
function viewportOf(
  state: Pick<AppState, "viewports">,
  path: string,
): WorkspaceViewport {
  return state.viewports?.[path] ?? EMPTY_VIEWPORT;
}

// ── Claims: who is holding which tab ──

/** A stable empty list, so a selector reading it does not re-render forever. */
const NO_CLAIMS: LayoutClaim[] = [];

/**
 * The tab this window holds, read out of the launch argument.
 *
 * Constant for the life of the renderer: a window is opened *as* the holder of
 * one tab (`--manor-claim=`), and the claim is released by the window closing,
 * never by it changing its mind. Main knows it from the same argument, so it
 * never travels in a viewport; here it only decides what this window shows.
 */
export const OWN_CLAIM: { workspacePath: string; tabId: string } | null =
  (typeof window !== "undefined" && window.electronAPI?.claim) || null;

/** Which bridge this renderer is on; a browser never hides a claimed tab. */
function rendererPlatform(): RendererPlatform | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.electronAPI?.platform;
}

function claimsOf(
  state: Partial<Pick<AppState, "claims">>,
  path: string,
): LayoutClaim[] {
  return state.claims?.[path] ?? NO_CLAIMS;
}

/** The tab this window holds in `path`, or null. */
function ownClaimIn(path: string): string | null {
  return OWN_CLAIM?.workspacePath === path ? OWN_CLAIM.tabId : null;
}

/** What decides which tabs of `path` this renderer shows. */
function visibilityOf(
  state: Partial<Pick<AppState, "claims">>,
  path: string,
): Visibility {
  return {
    claims: claimsOf(state, path),
    platform: rendererPlatform(),
    ownClaim: ownClaimIn(path),
  };
}

/** Whether this renderer shows `tabId` of `path` at all. */
function tabVisibleHere(
  state: Partial<Pick<AppState, "claims">>,
  path: string,
  tabId: string,
): boolean {
  return isTabVisible(tabId, visibilityOf(state, path));
}

/**
 * `reconcileViewport`, with what this renderer may not select folded in.
 *
 * Every viewport write in this store goes through here rather than through
 * the pure function, so a selection can never land on a tab that is popped
 * out into another window.
 */
function reconcileFor(
  state: Partial<Pick<AppState, "claims">>,
  path: string,
  layout: WorkspaceLayout,
  viewport: WorkspaceViewport,
): WorkspaceViewport {
  return reconcileViewport(layout, viewport, visibilityOf(state, path));
}

/** The tabs of a panel this renderer shows, in the panel's own order. */
export function selectVisibleTabs(
  state: Partial<Pick<AppState, "claims">>,
  path: string | null | undefined,
  panel: Panel | null | undefined,
): Tab[] {
  if (!path || !panel) return [];
  return visibleTabsFor(panel, visibilityOf(state, path));
}

/**
 * `useVisibleTabs(panel)` — the tabs to render, claims applied.
 *
 * Memoised on what decides it, because the filter builds a new array and a
 * zustand selector returning one on every store change would re-render the
 * tab bar on every keystroke.
 */
export function useVisibleTabs(
  workspacePath: string | null | undefined,
  panel: Panel | null | undefined,
): Tab[] {
  const claims = useAppStore((s) =>
    workspacePath ? claimsOf(s, workspacePath) : NO_CLAIMS,
  );
  const tabs = panel?.tabs;
  return useMemo(
    () =>
      visibleTabsFor(
        { tabs: tabs ?? [] },
        {
          claims,
          platform: rendererPlatform(),
          ownClaim: workspacePath ? ownClaimIn(workspacePath) : null,
        },
      ),
    [tabs, claims, workspacePath],
  );
}

// ── What a pane is, read off the tree ──

/**
 * Each layout's leaves by paneId, built once per layout object.
 *
 * A broadcast replaces a workspace's layout wholesale, so the object is the
 * version: a new one gets a new index, and the old one is collected with it.
 */
const leafIndexes = new WeakMap<WorkspaceLayout, Map<string, PaneLeaf>>();

function leafIndex(layout: WorkspaceLayout): Map<string, PaneLeaf> {
  let index = leafIndexes.get(layout);
  if (!index) {
    index = new Map();
    for (const { leaf } of layoutLeaves(layout)) index.set(leaf.paneId, leaf);
    leafIndexes.set(layout, index);
  }
  return index;
}

/** A pane's leaf in one layout; null when the layout has no such pane. */
export function leafOf(
  layout: WorkspaceLayout | null | undefined,
  paneId: string,
): PaneLeaf | null {
  return layout ? (leafIndex(layout).get(paneId) ?? null) : null;
}

/** A pane's leaf, in whichever workspace holds it; null for no such pane. */
function paneLeaf(
  state: Pick<AppState, "workspaceLayouts">,
  paneId: string,
): PaneLeaf | null {
  for (const layout of Object.values(state.workspaceLayouts)) {
    const leaf = leafOf(layout, paneId);
    if (leaf) return leaf;
  }
  return null;
}

/** The workspace holding a pane, or null. */
function workspaceOfPane(
  state: Pick<AppState, "workspaceLayouts">,
  paneId: string,
): string | null {
  for (const [path, layout] of Object.entries(state.workspaceLayouts)) {
    if (leafIndex(layout).has(paneId)) return path;
  }
  return null;
}

/** What a pane renders. A pane the tree does not know is a terminal. */
export function selectPaneContentType(
  state: Pick<AppState, "workspaceLayouts">,
  paneId: string,
): PaneContentType {
  return paneLeaf(state, paneId)?.contentType ?? "terminal";
}

/** Where a browser pane is: its webview's live url, else the saved one. */
export function selectPaneUrl(
  state: Pick<AppState, "workspaceLayouts" | "paneLiveUrl">,
  paneId: string,
): string | null {
  return state.paneLiveUrl[paneId] ?? paneLeaf(state, paneId)?.url ?? null;
}

/** Whether any workspace's layout still has `paneId`. */
export function selectHasPane(
  state: Pick<AppState, "workspaceLayouts">,
  paneId: string,
): boolean {
  return paneLeaf(state, paneId) !== null;
}

/** The file a file pane has open, workspace-relative; null for none. */
export function selectPaneFilePath(
  state: Pick<AppState, "workspaceLayouts">,
  paneId: string,
): string | null {
  return paneLeaf(state, paneId)?.filePath ?? null;
}

export function usePaneFilePath(paneId: string): string | null {
  return useAppStore((s) => selectPaneFilePath(s, paneId));
}

export function usePaneContentType(paneId: string): PaneContentType {
  return useAppStore((s) => selectPaneContentType(s, paneId));
}

export function usePaneUrl(paneId: string): string | null {
  return useAppStore((s) => selectPaneUrl(s, paneId));
}

/**
 * The panel this window has the keyboard in, for one workspace.
 *
 * Falls back to the leftmost panel: a viewport can name a panel another
 * renderer has since closed, and a workspace adopted this tick has no
 * viewport entry at all.
 */
export function activePanelIdOf(
  state: Pick<AppState, "workspaceLayouts" | "viewports">,
  path: string,
): string | null {
  const layout = state.workspaceLayouts[path];
  if (!layout) return null;
  const chosen = viewportOf(state, path).activePanelId;
  if (chosen !== null && layout.panels[chosen]) return chosen;
  const inTree = allPanelIds(layout.panelTree).find(
    (id) => layout.panels[id] !== undefined,
  );
  return inTree ?? Object.keys(layout.panels)[0] ?? null;
}

// Internal helpers for the active workspace. Their `path` is the active
// layout's key — a bare path on this machine — and they return
// null on the Home surface, see `activeLayoutKey`.
function getActivePanelContext(
  state: ViewportState,
): { path: WorkspaceKey; layout: WorkspaceLayout; panel: Panel } | null {
  const path = activeLayoutKey(state);
  if (!path) return null;
  const layout = state.workspaceLayouts[path];
  if (!layout) return null;
  const panelId = activePanelIdOf(state, path);
  const panel = panelId ? layout.panels[panelId] : undefined;
  if (!panel) return null;
  return { path, layout, panel };
}

/** The tab the active panel shows, with the context that found it. */
function getActiveTabContext(state: AppState): {
  path: WorkspaceKey;
  layout: WorkspaceLayout;
  panel: Panel;
  tab: Tab;
} | null {
  const ctx = getActivePanelContext(state);
  if (!ctx) return null;
  const tabId = selectSelectedTabId(state, ctx.panel.id, ctx.path);
  const tab = ctx.panel.tabs.find((t) => t.id === tabId);
  return tab ? { ...ctx, tab } : null;
}

/**
 * Write this window's viewport for one workspace, reconciled against the
 * layout it is about. Every viewport action goes through here, so no action
 * can leave a selection pointing at a tab that is not there.
 */
function withViewport(
  state: AppState,
  path: string,
  update: (viewport: WorkspaceViewport) => WorkspaceViewport,
): Partial<AppState> {
  const layout = state.workspaceLayouts[path];
  const current = viewportOf(state, path);
  const next = update(current);
  const reconciled = layout ? reconcileFor(state, path, layout, next) : next;
  if (reconciled === current || sameViewport(reconciled, current)) return {};
  return { viewports: { ...state.viewports, [path]: reconciled } };
}

function sameIds(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

/** Whether two viewports say the same thing, whatever their identity. */
function sameViewport(a: WorkspaceViewport, b: WorkspaceViewport): boolean {
  return (
    a.activePanelId === b.activePanelId &&
    sameIds(a.selectedTabIds, b.selectedTabIds) &&
    sameIds(a.focusedPaneIds, b.focusedPaneIds)
  );
}

/**
 * `state` itself when `patch` changes nothing, so a no-op action — a click on
 * the pane or panel that already has focus — writes nothing and nothing
 * re-renders. zustand notifies on any new state object, `{}` included.
 */
function orSame(state: AppState, patch: Partial<AppState>): AppState | Partial<AppState> {
  return Object.keys(patch).length === 0 ? state : patch;
}

/**
 * A viewport move that puts a tab in front of the user leaves the Tasks view;
 * one that moves nothing leaves everything alone.
 */
function toWorkspace(
  state: AppState,
  patch: Partial<AppState>,
): AppState | Partial<AppState> {
  if (Object.keys(patch).length === 0) return state;
  return { ...WORKSPACE_SURFACE, ...patch };
}

/**
 * An action that sends a command which puts a tab or pane in front of the
 * user leaves the Tasks view now, not when the broadcast lands.
 */
function leaveTasksView(): void {
  if (useAppStore.getState().activeSurface !== "workspace") {
    useAppStore.setState(WORKSPACE_SURFACE);
  }
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

function getActiveLayoutContext(state: AppState): { path: WorkspaceKey; layout: WorkspaceLayout } | null {
  const path = activeLayoutKey(state);
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

/**
 * Move the selection one tab along, wrapping, across every panel of the
 * active workspace. `cmd+shift+]` is a workspace-wide walk, not a per-panel
 * one, so the panel changes with it.
 */
function stepTab(state: AppState, step: 1 | -1): Partial<AppState> {
  const ctx = getActivePanelContext(state);
  if (!ctx) return {};
  const tabs = globalTabList(ctx.layout);
  if (tabs.length === 0) return {};
  const current = selectSelectedTabId(state, ctx.panel.id, ctx.path);
  const currentIdx = tabs.findIndex((t) => t.tabId === current);
  const nextIdx = (currentIdx + step + tabs.length) % tabs.length;
  return selectTabLocally(state, ctx.path, tabs[nextIdx].tabId);
}

/** The active workspace's diff pane, wherever it is — there is at most one. */
function findDiffPane(
  state: AppState,
): { paneId: string; tabId: string } | null {
  const ctx = getActiveLayoutContext(state);
  return ctx ? findDiffPaneIn(ctx.layout) : null;
}

/**
 * Put this window's attention on a pane: its panel active, its tab selected,
 * the pane focused. Viewport, so it is written into this renderer's own slice
 * and no command goes anywhere.
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
    return withViewport(state, path, (vp) => ({
      ...vp,
      activePanelId: panelId,
      selectedTabIds: { ...vp.selectedTabIds, [panelId]: tab.id },
      focusedPaneIds: { ...vp.focusedPaneIds, [tab.id]: paneId },
    }));
  }
  return {};
}

/** Walk the keyboard one panel along the panel tree. */
function stepPanel(
  state: AppState,
  step: (tree: PanelNode, from: string) => string | null,
): Partial<AppState> {
  const ctx = getActivePanelContext(state);
  if (!ctx) return {};
  const next = step(ctx.layout.panelTree, ctx.panel.id);
  if (!next) return {};
  return withViewport(state, ctx.path, (vp) => ({
    ...vp,
    activePanelId: next,
  }));
}

/**
 * Walk the focus one pane along inside the tab the active panel is showing.
 */
function stepPane(
  state: AppState,
  step: (node: PaneNode, from: string) => string | null,
): Partial<AppState> {
  const ctx = getActiveTabContext(state);
  if (!ctx) return {};
  const current = selectFocusedPaneId(state, ctx.tab.id, ctx.path);
  if (!current) return {};
  const next = step(ctx.tab.rootNode, current);
  if (!next) return {};
  return withViewport(state, ctx.path, (vp) => ({
    ...vp,
    focusedPaneIds: { ...vp.focusedPaneIds, [ctx.tab.id]: next },
  }));
}

/** Select a tab, wherever it is: its panel shows it and takes the keyboard. */
function selectTabLocally(
  state: AppState,
  path: string,
  tabId: string,
): Partial<AppState> {
  const layout = state.workspaceLayouts[path];
  if (!layout) return {};
  const found = findPanelWithTab(layout, tabId);
  if (!found) return {};
  return withViewport(state, path, (vp) => ({
    ...vp,
    activePanelId: found.panel.id,
    selectedTabIds: { ...vp.selectedTabIds, [found.panel.id]: tabId },
  }));
}

// ── Layout, owned by the Manor server ──
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
// The actions that only move *this window's* attention — select a tab, focus
// a pane, activate a panel — send nothing at all. They are viewport,
// they write the `viewports` slice, and the server has no answer to "which
// window?" to give them.

/**
 * A layout write the host refused (`unavailable:host-away`, `unavailable:host`)
 * becomes the once-per-session toast, keyed by the refusal's code so an away
 * host and a refused method each speak once. Anything else is not handled
 * here and returns false.
 */
function refuseLayoutWrite(err: unknown): boolean {
  if (!(err instanceof BridgeUnavailableError)) return false;
  handleBridgeUnavailable(`layout-write:${err.code}`, err.message)(err);
  return true;
}

/**
 * Send one command for one workspace, and forget it.
 *
 * Nothing waits for the answer: what the caller actually wants — the new
 * layout — arrives at every renderer at once on `layout.changed`, with the
 * command's selection hint for this one. A command naming an id the server
 * does not have is a no-op there, not an error.
 *
 * The one thing read off the answer is a hint for a command that changed
 * nothing: no broadcast follows it, so the hint is applied here instead. A
 * version that did not move past the one held when the command went out is
 * how that is told.
 */
/**
 * Send a command that closes panes, once the file panes among them have no
 * unsaved edits: with some, the unsaved-edits confirm asks first.
 */
function sendClosingCommand(workspacePath: string, command: LayoutCommand): void {
  // Dry-run again after every wait: what closes is what the layout says
  // when the command goes, not when it was asked for.
  const closing = () => {
    const layout = useAppStore.getState().workspaceLayouts[workspacePath];
    return layout ? applyLayoutCommand({ layout, closedStack: [] }, command).killPanes : [];
  };
  guardClosingPanes(closing, "close", filePanesAmong, () =>
    sendLayoutCommand(workspacePath, command),
  );
}

/**
 * Those of `paneIds` that are file panes, in whichever window shows them:
 * the ones that may hold unsaved edits, here or in another window.
 */
export function filePanesAmong(paneIds: readonly string[]): string[] {
  const state = useAppStore.getState();
  return paneIds.filter((paneId) => selectPaneContentType(state, paneId) === "file");
}

const ACTIVE_AGENT_STATUSES = ["thinking", "working", "requires_input"];

/** Whether an agent is working, thinking or waiting on you in any of `paneIds`. */
export function selectAgentRunningIn(
  state: Pick<AppState, "paneAgentStatus">,
  paneIds: readonly string[],
): boolean {
  return paneIds.some((paneId) => {
    const agent = state.paneAgentStatus[paneId];
    return agent !== undefined && ACTIVE_AGENT_STATUSES.includes(agent.status);
  });
}

function sendLayoutCommand(
  workspacePath: string,
  command: LayoutCommand,
): void {
  const held = useAppStore.getState().layoutVersions[workspacePath] ?? 0;
  const applied = window.electronAPI?.layout?.apply(workspacePath, command);
  void applied
    ?.then((result) => {
      if (!result) return;
      if ("error" in result) {
        console.error(`[layout] ${command.type} refused:`, result.error);
        return;
      }
      const { hint } = result;
      if (!hint || result.version !== held) return;
      useAppStore.setState((state) => {
        const layout = state.workspaceLayouts[workspacePath];
        if (!layout) return {};
        return withViewport(state, workspacePath, (vp) =>
          applyHint(layout, vp, hint, visibilityOf(state, workspacePath)),
        );
      });
    })
    .catch((err: unknown) => {
      if (refuseLayoutWrite(err)) return;
      console.error(`[layout] ${command.type} failed:`, err);
    });
}

/**
 * Queue a command for a pane that has no shell yet.
 *
 * "New tab running `pnpm dev`", "split with agent", an agent launch: the line
 * has to wait somewhere between the layout change and the pane's first
 * `pty.create`, and that somewhere is the server — the same map `POST /tabs
 * { command }` fills, so the desktop and a route take one road. It used to be
 * a `pendingPaneCommands` entry in this store, which only worked because the
 * renderer that queued it was also the one that mounted the pane.
 *
 * `opts.prompt` is an agent's first message, kept apart from `text` so the
 * server can deliver it through a file on the pane's host instead of typing
 * it inline.
 *
 * Send this *before* the `apply` that creates the pane. Both go over the same
 * ordered channel and the main-side handler is synchronous, so the entry is
 * recorded before the broadcast that makes any renderer mount the pane.
 */
export function sendPendingCommand(
  paneId: string,
  text: string,
  kind: "shell" | "agent-startup" = "shell",
  opts?: { submit?: boolean; prompt?: string },
): void {
  void window.electronAPI?.layout
    ?.setPendingCommand(paneId, text, kind, opts)
    ?.catch((err: unknown) => {
      if (refuseLayoutWrite(err)) return;
      console.error(`[layout] pending command for ${paneId} failed:`, err);
    });
}

/**
 * What a replica change reaches outside the store with: a closed pane's host
 * is no longer this window's to badge, or to recover when the host comes back
 * and a popout whose tab went has nothing left to show.
 */
function afterReplicaChange(
  gone: readonly string[],
  adopted: readonly string[],
  removed: readonly string[],
): void {
  const remote = useRemotePaneStore.getState();
  for (const paneId of gone) remote.forgetPane(paneId);
  const state = useAppStore.getState();
  for (const workspacePath of adopted) {
    checkOwnClaim(
      workspacePath,
      claimsOf(state, workspacePath),
      state.workspaceLayouts[workspacePath],
    );
  }
  if (OWN_CLAIM && removed.includes(OWN_CLAIM.workspacePath)) closeLostWindow();
}

/**
 * The server changed a workspace. Replace the replica with what it sent
 * (`adoptLayout` has the version guard and the viewport repair).
 *
 * A `removed` broadcast forgets this renderer's copy instead — adopting it
 * would bring back a workspace whose worktree no longer exists. Nothing is
 * sent: the server ends the panes and forgets the workspace itself when the
 * worktree goes.
 */
function applyLayoutChanged(payload: LayoutChangedPayload): void {
  const { workspacePath, version, layout, restored, origin, hint } = payload;
  const claims = payload.claims ?? NO_CLAIMS;
  if (payload.removed) {
    useAppStore.setState((state) => withoutWorkspace(state, workspacePath));
    afterReplicaChange([], [], [workspacePath]);
    return;
  }
  let gone: string[] = [];
  useAppStore.setState((state) => {
    const result = adoptLayout(
      state,
      { workspacePath, version, layout, claims },
      {
        visibilityOf,
        activeKey: selectActiveWorkspaceKey(state),
        // The command's selection hint applies only to the renderer that
        // sent it.
        hint:
          hint && origin.id === rendererId()
            ? (tree, viewport, visibility) =>
                applyHint(tree, viewport, hint, visibility)
            : undefined,
      },
    );
    if (!result) return {};
    gone = result.gone;
    const { patch } = result;
    // A reopen inside the server's grace hands the pane back its still-warm
    // session. Seed what the server knew about it, the
    // way a snapshot does, so the pane mounts in the cwd it was in and under
    // the title it had rather than looking brand new.
    if (restored) {
      const { cwds, titles, agents } = sessionSideMaps(restored);
      Object.assign(patch, {
        paneCwd: { ...(patch.paneCwd ?? state.paneCwd), ...cwds },
        paneTitle: { ...(patch.paneTitle ?? state.paneTitle), ...titles },
        paneAgentStatus: {
          ...(patch.paneAgentStatus ?? state.paneAgentStatus),
          ...agents,
        },
      });
    }
    return patch;
  });
  afterReplicaChange(gone, [], []);
  checkOwnClaim(workspacePath, claims, layout);
}

/**
 * Read every workspace and merge it into the replica (`applyLayoutSnapshot`)
 * — the boot read and a resync. `read` answers the entries, plus the
 * viewports to seed when it is the boot's (see `SnapshotOptions`).
 */
async function loadLayoutSnapshot(
  read: () => Promise<
    | {
        entries: Record<string, LayoutEntry>;
        seedViewports?: Record<string, WorkspaceViewport>;
      }
    | undefined
  >,
): Promise<void> {
  const before = useAppStore.getState().layoutVersions;
  const snapshot = await read();
  if (!snapshot) return;
  let result: SnapshotResult | null = null;
  useAppStore.setState((state) => {
    result = applyLayoutSnapshot(state, snapshot.entries, {
      visibilityOf,
      activeKey: selectActiveWorkspaceKey(state),
      before,
      seedViewports: snapshot.seedViewports,
    });
    return result.next;
  });
  const { gone, adopted, removed } = result!;
  afterReplicaChange(gone, adopted, removed);
}

/**
 * A window that no longer holds its tab has nothing to show, and closes.
 *
 * Two ways to lose it, and they land the same: another window claimed the
 * same tab (claims are exclusive, the newcomer wins), or the tab left the
 * workspace entirely because somebody closed it. Either way this window is
 * looking at nothing, which is what the old hand-off expressed by emptying
 * the popout's store.
 *
 * Gated on having been *seen* in the claims at least once, so the broadcast
 * that arrives between this window booting and its first viewport report —
 * where nobody holds the tab yet — is not read as a loss.
 */
let sawOwnClaim = false;

function checkOwnClaim(
  workspacePath: string,
  claims: readonly LayoutClaim[],
  layout: WorkspaceLayout,
): void {
  if (!OWN_CLAIM || OWN_CLAIM.workspacePath !== workspacePath) return;
  const mine = holdsClaim(claims, rendererId(), OWN_CLAIM.tabId);
  if (mine) {
    sawOwnClaim = true;
    return;
  }
  const tabGone = !findPanelWithTab(layout, OWN_CLAIM.tabId);
  if (!sawOwnClaim && !tabGone) return;
  closeLostWindow();
}

/**
 * Close this window, which lost its tab. Unsaved file edits in it ask Save
 * or Discard first, in the window, once (`closeOverLostTab`): the native
 * close prompt would offer a Cancel that keeps a window with nothing to
 * show, and every later replica change would ask again.
 */
function closeLostWindow(): void {
  closeOverLostTab(() => window.electronAPI?.window?.closeSelf?.());
}

/**
 * The surface to reopen on relaunch (including Home's `HOME_PATH`).
 *
 * This renderer's own, out of its viewport file — which is the point of
 * Two windows of one host reopen where each of them was, not
 * where the last command happened to land. The server's
 * `layout.getLastActive()` is the fallback for a renderer that has never
 * saved a viewport, and for the very first launch it is null too.
 */
let lastActiveWorkspacePath: string | null = null;

/**
 * The pane ids of each workspace in the layout read at launch, by workspace
 * key, until `seedRestoredPanes` takes the shown one's. Null
 * before the read and after the seed, so only the launch's pick seeds.
 */
let launchPanes: Map<string, Set<string>> | null = null;

export function getPersistedActiveWorkspacePath(): string | null {
  return lastActiveWorkspacePath;
}

// ──────────────────────── viewport, per renderer ─────────────────────────

/**
 * Who this renderer is, as the server names it in a command's origin: the
 * desktop's `webContents.id`, a browser's bridge connection id. Read fresh
 * every time — the web bridge only learns it once the socket says hello, and
 * learns a new one after a reconnect.
 */
function rendererId(): string | null {
  return window.electronAPI?.rendererId ?? null;
}

/** How long a selection waits before it reaches this renderer's file. */
const VIEWPORT_DEBOUNCE_MS = 300;

/**
 * A claiming window's viewport is ephemeral.
 *
 * It is one tab and the pane focused inside it — a fact about a window that
 * exists only while it is open. Writing it to `viewport.json` would hand the
 * primary a workspace of one tab on the next launch, which is precisely the
 * state claims exist to stop happening.
 */
function persistsViewport(): boolean {
  return OWN_CLAIM === null;
}

let viewportTimer: ReturnType<typeof setTimeout> | null = null;

/** Write this renderer's whole viewport file, debounced. */
function scheduleViewportSave(): void {
  if (!persistsViewport()) return;
  if (viewportTimer) return;
  viewportTimer = setTimeout(() => {
    viewportTimer = null;
    const state = useAppStore.getState();
    const { viewports } = state;
    // The active surface as a key, so a relaunch reopens the
    // workspace on the host it was on; Home's `HOME_PATH` as itself.
    const activeWorkspacePath = selectActiveWorkspaceKey(state);
    const api = window.electronAPI;
    if (!api?.viewport) return;
    void api.viewport
      .save({ version: 1, activeWorkspacePath, workspaces: viewports })
      ?.catch(
        handleBridgeUnavailable(
          "viewport-save",
          "This browser cannot remember which tabs you had selected.",
        ),
      );
  }, VIEWPORT_DEBOUNCE_MS);
  viewportTimer.unref?.();
}

/**
 * Tell the host what this renderer is looking at.
 *
 * Fire-and-forget: the server keeps the last report as the workspace's
 * **default viewport**, which is what a renderer that has never seen this
 * workspace is handed. Nothing here waits for it and nothing reads it
 * back.
 */
/**
 * This renderer's viewport file, or null when it has none — a first launch,
 * a detached window, a browser whose `localStorage` is empty. A failure to
 * read it is a first launch too: booting without a remembered selection is a
 * great deal better than not booting.
 */
async function loadOwnViewport(): Promise<PersistedViewportFile | null> {
  if (!persistsViewport()) return null;
  try {
    return (await window.electronAPI?.viewport?.load()) ?? null;
  } catch (err) {
    console.error("[viewport] failed to read the viewport file:", err);
    return null;
  }
}

function reportViewport(
  workspacePath: string,
  viewport: WorkspaceViewport,
): void {
  // A claiming window reports too, and its report is the *only* way the host
  // learns who is holding what. The server keeps the claim and leaves the
  // default viewport alone, so one tab never becomes the workspace's default.
  // The host knows who is reporting from the connection; a renderer it has
  // not named yet has no connection to report over.
  const api = window.electronAPI;
  if (!api?.layout?.reportViewport || rendererId() === null) return;
  void api.layout
    .reportViewport(workspacePath, viewport)
    ?.catch(
      handleBridgeUnavailable(
        "viewport-report",
        "This browser cannot tell Manor which tabs it is showing.",
      ),
    );
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaceLayouts: {},
  layoutVersions: {},
  mountedWorkspaces: {},
  viewports: {},
  claims: {},
  activeWorkspacePath: null,
  activeWorkspaceHostId: LOCAL_HOST_ID,
  activeSurface: "workspace",
  composerDraft: { text: "", target: null },
  tasksIntent: null,
  paneCwd: {},
  paneTitle: {},
  paneAgentStatus: {},
  paneFavicon: {},
  paneAudioPlaying: {},
  paneAudioMuted: {},
  paneRecordingStartedAt: {},
  paneLiveUrl: {},
  panePickedElement: {},
  webviewFocusedPaneId: null,
  layoutLoaded: false,
  layoutLoadError: null,
  restoredPaneIds: new Set<string>(),
  paneFocusNonce: 0,
  pendingCloseConfirmPaneId: null,
  pendingCloseConfirmTabId: null,
  worktreeSetupState: {},

  loadPersistedLayout: async () => {
    try {
      const api = window.electronAPI;
      // Every workspace lands now, but none is rendered until it is first
      // opened (`setActiveWorkspace`): rendering them all here would mount
      // every pane of every workspace at boot, and each mount creates a PTY.
      await loadLayoutSnapshot(async () => {
        const [entries, lastActive, ownViewport] = await Promise.all([
          api?.layout.getAll() ?? {},
          api?.layout.getLastActive() ?? null,
          loadOwnViewport(),
        ]);
        lastActiveWorkspacePath =
          ownViewport?.activeWorkspacePath ?? lastActive;
        // What this launch restores, by workspace, until the launch picks
        // the one it shows (`seedRestoredPanes`).
        launchPanes = new Map(
          Object.entries(entries).map(([key, entry]) => [key, layoutPaneIds(entry.layout)]),
        );
        return { entries, seedViewports: ownViewport?.workspaces ?? {} };
      });
      // A relaunch after a failed boot read (`lib/launch.ts`) succeeded.
      set({ layoutLoadError: null });
    } catch (err) {
      console.error("[layout] failed to read the layout:", err);
      set({ layoutLoadError: ipcErrorMessage(err) });
      // A detached window has nothing to show without it.
    }
    set({ layoutLoaded: true });
  },

  seedRestoredPanes: () => {
    const panes = launchPanes;
    launchPanes = null;
    const key = selectActiveWorkspaceKey(get());
    const restored = key ? panes?.get(key) : undefined;
    if (restored) set({ restoredPaneIds: new Set(restored) });
  },

  forgetRestoredPane: (paneId) => {
    const { restoredPaneIds } = get();
    if (!restoredPaneIds.has(paneId)) return;
    const rest = new Set(restoredPaneIds);
    rest.delete(paneId);
    set({ restoredPaneIds: rest });
  },

  setActiveWorkspace: (path: string, hostId?: HostId | null) =>
    set((state) => {
      const key = layoutKeyFor(path, hostId);
      const active = {
        ...WORKSPACE_SURFACE,
        activeWorkspacePath: path,
        activeWorkspaceHostId: parseWorkspaceKey(key).hostId,
      };
      // Home is the Dashboard: selectable as the active surface,
      // but it never gets a layout.
      if (isHomePath(path)) return active;
      return { ...active, ...mountPatch(state, key) };
    }),

  showTasksView: (intent) =>
    set((state) => {
      if (intent) return { activeSurface: "tasks", tasksIntent: intent };
      return state.activeSurface === "tasks"
        ? state
        : { activeSurface: "tasks" };
    }),

  showComposer: () => set({ activeSurface: "composer" }),
  closeComposer: () => set({ activeSurface: "workspace" }),
  setComposerDraft: (patch) =>
    set((state) => ({ composerDraft: { ...state.composerDraft, ...patch } })),
  clearComposerDraft: () => set({ composerDraft: { text: "", target: null } }),

  consumeTasksIntent: () => {
    const intent = get().tasksIntent;
    if (intent) set({ tasksIntent: null });
    return intent;
  },

  navigateToContext: ({ workspaceKey: key, tabId, paneId }) =>
    set((state) => {
      const layout = state.workspaceLayouts[key];
      if (!layout) return state;

      // Find the panel that contains the requested tab
      const entry = findPanelWithTab(layout, tabId);
      if (!entry) return state;

      const { panel } = entry;
      const { hostId, path } = parseWorkspaceKey(key);

      return {
        ...WORKSPACE_SURFACE,
        activeWorkspacePath: path,
        activeWorkspaceHostId: hostId,
        ...withViewport(state, key, (vp) => ({
          ...vp,
          activePanelId: panel.id,
          selectedTabIds: { ...vp.selectedTabIds, [panel.id]: tabId },
          focusedPaneIds: { ...vp.focusedPaneIds, [tabId]: paneId },
        })),
      };
    }),

  addTab: (adoptPaneId?: string) => {
    const path = activeLayoutKey(get());
    if (!path) return null;
    const tab = createTab(undefined, adoptPaneId);
    leaveTasksView();
    sendLayoutCommand(path, { type: "new-tab", tab, ...activePanelOf(get()) });
    return { tabId: tab.id, paneId: firstPaneOfTab(tab) };
  },

  addTerminalTab: (
    command: string,
    opts?: {
      submit?: boolean;
      kind?: "shell" | "agent-startup";
      prompt?: string;
    },
  ) => {
    const path = activeLayoutKey(get());
    if (!path) return null;
    const tab = createTab();
    const tabPaneId = firstPaneOfTab(tab);
    leaveTasksView();
    // The command first, the tab second: the pane mounts when the broadcast
    // lands, and `pty.create` is what types this.
    sendPendingCommand(tabPaneId, command, opts?.kind ?? "shell", {
      submit: opts?.submit ?? true,
      prompt: opts?.prompt,
    });
    sendLayoutCommand(path, { type: "new-tab", tab, ...activePanelOf(get()) });
    return { tabId: tab.id, paneId: tabPaneId };
  },

  addTerminalTabIn: (key, command, opts) => {
    set((state) => mountPatch(state, key));
    const tab = createTab();
    const paneId = firstPaneOfTab(tab);
    sendPendingCommand(paneId, command, opts?.kind ?? "shell", {
      prompt: opts?.prompt,
    });
    // No panel named: it lands in the workspace's first panel, or the one the
    // server creates for a workspace with no layout yet.
    sendLayoutCommand(key, { type: "new-tab", tab });
    return { tabId: tab.id, paneId };
  },

  addBrowserTab: (url: string, opts?: { background?: boolean }) => {
    const path = activeLayoutKey(get());
    if (!path) return null;
    const tab = createBrowserTab(url);
    const paneId = firstPaneOfTab(tab);
    // The leaf carries the type and the url; the pane mounts when the
    // broadcast brings it back, already knowing what it is.
    const background = opts?.background ?? false;
    // A background tab doesn't take the user anywhere.
    if (!background) leaveTasksView();
    sendLayoutCommand(path, {
      type: "new-tab",
      tab,
      ...activePanelOf(get()),
      select: !background,
    });
    return { tabId: tab.id, paneId };
  },

  addDiffTab: () => {
    const path = activeLayoutKey(get());
    if (!path) return;
    const tab = createDiffTab();
    leaveTasksView();
    sendLayoutCommand(path, { type: "new-tab", tab, ...activePanelOf(get()) });
  },

  addFileTab: (filePath, at) => {
    const path = at?.workspaceKey ?? activeLayoutKey(get());
    if (!path) return null;
    const tab = createFileTab(filePath);
    leaveTasksView();
    const panel = at ? { panelId: at.panelId } : activePanelOf(get());
    sendLayoutCommand(path, { type: "new-tab", tab, ...panel });
    return { tabId: tab.id, paneId: firstPaneOfTab(tab) };
  },

  duplicateTab: (tabId: string) => {
    const state = get();
    const path = activeLayoutKey(state);
    if (!path) return null;
    const layout = state.workspaceLayouts[path];
    if (!layout) return null;
    const found = findPanelWithTab(layout, tabId);
    if (!found) return null;
    const { tab: newTab } = cloneTabWithFreshIds(found.tab);
    leaveTasksView();
    sendLayoutCommand(path, { type: "duplicate-tab", tabId, newTab });
    return newTab.id;
  },

  openOrFocusDiff: () => {
    const state = get();
    const path = activeLayoutKey(state);
    if (!path) return null;
    const existing = findDiffPane(state);
    // Already open somewhere — this is a viewport move, not a layout change.
    if (existing) {
      set({
        ...WORKSPACE_SURFACE,
        ...focusPaneLocally(state, path, existing.paneId),
      });
      return existing.tabId;
    }
    const tab = createDiffTab();
    leaveTasksView();
    sendLayoutCommand(path, {
      type: "new-tab",
      tab,
      ...activePanelOf(state),
    });
    return tab.id;
  },

  openDiffInNewPanel: () => {
    const state = get();
    const path = activeLayoutKey(state);
    if (!path) return;
    const existing = findDiffPane(state);
    if (existing) {
      set({
        ...WORKSPACE_SURFACE,
        ...focusPaneLocally(state, path, existing.paneId),
      });
      return;
    }
    const ctx = getActivePanelContext(state);
    if (!ctx) return;
    const tab = createDiffTab();
    leaveTasksView();
    // Not `new-tab` + `split-panel`: that would move the panel's selected tab
    // into the new panel. The diff opens *beside* what is already there.
    sendLayoutCommand(path, {
      type: "split-panel-with-new-tab",
      tab,
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
    const path = activeLayoutKey(get());
    if (path) sendLayoutCommand(path, { type: "close-tab", tabId });
  },

  // Unsaved edits in any of the tabs going ask first.
  closeOtherTabs: (tabId: string) => {
    const path = activeLayoutKey(get());
    if (path) sendClosingCommand(path, { type: "close-other-tabs", tabId });
  },

  closeTabsToRight: (tabId: string) => {
    const path = activeLayoutKey(get());
    if (path) sendClosingCommand(path, { type: "close-tabs-to-right", tabId });
  },

  // ── Viewport ──
  //
  // Selecting a tab, focusing a pane, activating a panel: what *this* window
  // is looking at. No command goes out — the server has no answer to "which
  // window?" — so these write this renderer's own viewport slice, which is
  // persisted per renderer and reconciled against every broadcast.
  selectTab: (tabId: string) =>
    set((state) => {
      const path = activeLayoutKey(state);
      if (!path) return state;
      return toWorkspace(state, selectTabLocally(state, path, tabId));
    }),

  selectTabByGlobalIndex: (index: number) =>
    set((state) => {
      const ctx = getActiveLayoutContext(state);
      if (!ctx) return state;
      const tabs = globalTabList(ctx.layout);
      if (index < 0 || index >= tabs.length) return state;
      return toWorkspace(state, selectTabLocally(state, ctx.path, tabs[index].tabId));
    }),

  selectNextTab: () => set((state) => toWorkspace(state, stepTab(state, 1))),

  selectPrevTab: () => set((state) => toWorkspace(state, stepTab(state, -1))),

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
    const path = activeLayoutKey(get());
    if (path) sendLayoutCommand(path, { type: "toggle-pin-tab", tabId });
  },

  // "Split the focused pane" is resolved here, from this window's viewport:
  // the command names a pane id, and the server never asks what anyone is
  // looking at.
  splitPane: (direction: SplitDirection) => {
    const paneId = selectFocusedPaneOfActiveTab(get());
    const path = activeLayoutKey(get());
    if (!paneId || !path) return;
    leaveTasksView();
    sendLayoutCommand(path, {
      type: "split-pane-at",
      paneId,
      direction,
      position: "second",
      newPaneId: newPaneId(),
    });
  },

  splitPaneAt: (
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
    opts?: {
      contentType?: "terminal" | "browser" | "diff" | "file" | "agent";
      paneCommand?: string;
      url?: string;
      /** A file pane's open file, workspace-relative. */
      filePath?: string;
    },
  ) => {
    const state = get();
    const ctx = getActiveLayoutContext(state);
    // Checked against this window's replica so the caller hears "no such
    // pane" now rather than nothing at all: on the server an unknown id is a
    // silent no-op, and `splitPaneAt` answers with the id it minted.
    if (!ctx || !findPanelWithPane(ctx.layout, targetPaneId)) return null;
    const newPane = newPaneId();
    const { contentType, paneCommand, url, filePath } = opts ?? {};
    // "agent" panes are terminals that auto-run a command -- don't persist as
    // a content type.
    const treeContentType = contentType === "agent" ? undefined : contentType;
    leaveTasksView();
    if (paneCommand) {
      sendPendingCommand(
        newPane,
        paneCommand,
        contentType === "agent" ? "agent-startup" : "shell",
      );
    }
    sendLayoutCommand(ctx.path, {
      type: "split-pane-at",
      paneId: targetPaneId,
      direction,
      position,
      newPaneId: newPane,
      contentType: treeContentType,
      url,
      filePath,
    });
    return newPane;
  },

  movePaneToTarget: (
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => {
    const path = activeLayoutKey(get());
    if (!path) return;
    sendLayoutCommand(path, {
      type: "move-pane",
      sourcePaneId,
      targetPaneId,
      direction,
      position,
    });
  },

  moveTabToPane: (
    tabId: string,
    targetPaneId: string,
    direction: SplitDirection,
    position: "first" | "second",
  ) => {
    const path = activeLayoutKey(get());
    if (!path) return;
    sendLayoutCommand(path, {
      type: "move-tab-to-pane",
      tabId,
      targetPaneId,
      direction,
      position,
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
    // command is sent, which is what lets this stay synchronous. A pane that
    // is its tab already, staying put, changes nothing on the server, whose
    // answer still carries the hint that selects it (see `sendLayoutCommand`).
    const sole =
      found.tab.rootNode.type === "leaf" &&
      found.tab.rootNode.paneId === paneId;
    const mintedTabId = newTabId();
    sendLayoutCommand(ctx.path, {
      type: "extract-pane-to-tab",
      paneId,
      targetPanelId,
      newTabId: mintedTabId,
    });
    return sole ? found.tab.id : mintedTabId;
  },

  closePane: () => {
    const paneId = selectFocusedPaneOfActiveTab(get());
    if (paneId) get().closePaneById(paneId);
  },

  closePaneById: (paneId: string) => {
    const state = get();
    const ctx = getActiveLayoutContext(state);
    // A pane the replica no longer holds has already been closed — by this
    // window a moment ago, or by another renderer. Its `pty.onExit` arrives
    // here too, and must not close it a second time. The server abandons the
    // pane's agent when the close lands.
    if (!ctx || !findPanelWithPane(ctx.layout, paneId)) return;
    sendLayoutCommand(ctx.path, { type: "close-pane", paneId });
  },

  /**
   * Put back the last thing closed in this workspace.
   *
   * The stack is the server's, so this sends the command and
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


    // A running agent, or a file pane's unsaved edits, ask first.
    const paneIds = allPaneIds(tab.rootNode);
    if (selectAgentRunningIn(state, paneIds) || paneIds.some(hasUnsavedEdits)) {
      set({ pendingCloseConfirmTabId: tabId });
    } else {
      get().closeTab(tabId);
    }
  },

  requestClosePane: () => {
    const paneId = selectFocusedPaneOfActiveTab(get());
    if (paneId) get().requestClosePaneById(paneId);
  },

  requestClosePaneById: (paneId: string) => {
    // A running agent, or a file pane's unsaved edits, ask first.
    if (selectAgentRunningIn(get(), [paneId]) || hasUnsavedEdits(paneId)) {
      set({ pendingCloseConfirmPaneId: paneId });
    } else {
      get().closePaneById(paneId);
    }
  },

  // Any pane, in any panel — the same scope `list_panes` and `movePaneToTarget`
  // use, not just the active panel's.
  // Runs on every mouse-down in a terminal: an already-focused pane keeps the
  // same state, so nothing re-renders (see `orSame`).
  focusPane: (paneId: string) =>
    set((state) => {
      const path = activeLayoutKey(state);
      if (!path) return state;
      return orSame(state, focusPaneLocally(state, path, paneId));
    }),

  focusNextPane: () => set((state) => orSame(state, stepPane(state, nextPaneId))),

  focusPrevPane: () => set((state) => orSame(state, stepPane(state, prevPaneId))),

  // Which pane is focused does not change — only the demand that it actually
  // hold the keyboard. The nonce is the whole message; the pane's auto-focus
  // effect listens for the bump.
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
   * Written here *and* sent: the map is what this window renders now, and
   * `layout.setPaneTitle` is what reaches the server's `paneSessions` and so
   * the file. Off the command channel — `layout.changed` never
   * carries a title — so the bridge call is fire-and-forget the same way
   * `layout.reportViewport` is, and every other renderer hears it back on
   * `layout.onPaneTitle` rather than from this write.
   */
  setPaneTitle: (paneId: string, title: string) => {
    const state = get();
    if (state.paneTitle[paneId] === title) return;
    set({ paneTitle: { ...state.paneTitle, [paneId]: title } });
    void window.electronAPI?.layout?.setPaneTitle(paneId, title);
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
   * `paneLiveUrl` is this window's; the leaf's `url` is the layout's, and it
   * is what makes the pane come back on the same page after a relaunch — so
   * the same fact goes out as a command. Only for a pane the tree calls a
   * browser: `set-pane-content-type` is what carries a url, and sending it
   * for a terminal would retype the pane.
   */
  setPaneUrl: (paneId: string, url: string) => {
    const state = get();
    if (selectPaneUrl(state, paneId) === url) return;
    set({ paneLiveUrl: { ...state.paneLiveUrl, [paneId]: url } });
    if (selectPaneContentType(state, paneId) !== "browser") return;
    const path = workspaceOfPane(state, paneId);
    if (!path) return;
    sendLayoutCommand(path, {
      type: "set-pane-content-type",
      paneId,
      contentType: "browser",
      url,
    });
  },

  // The leaf is where the type lives; the pane re-renders as the new one
  // when the broadcast brings it back.
  setPaneContentType: (paneId: string, contentType: PaneContentType) => {
    const state = get();
    if (selectPaneContentType(state, paneId) === contentType) return;
    const path = workspaceOfPane(state, paneId);
    if (!path) return;
    sendLayoutCommand(path, {
      type: "set-pane-content-type",
      paneId,
      contentType,
    });
  },

  // The open file is structure, like a browser's url: it is what brings the
  // pane back on the same file after a relaunch, and every renderer of the
  // workspace shows it.
  setPaneFilePath: (paneId: string, filePath: string) => {
    const state = get();
    if (selectPaneContentType(state, paneId) !== "file") return;
    if (selectPaneFilePath(state, paneId) === filePath) return;
    const path = workspaceOfPane(state, paneId);
    if (!path) return;
    sendLayoutCommand(path, {
      type: "set-pane-content-type",
      paneId,
      contentType: "file",
      filePath,
    });
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

  setPaneAgentStatus: (update: PaneAgentStatusUpdate) =>
    set((state) => {
      const { paneId, ...next } = update;
      const current = state.paneAgentStatus[paneId];
      if (
        current &&
        current.status === next.status &&
        current.kind === next.kind &&
        current.reason === next.reason
      )
        return state;
      return { paneAgentStatus: { ...state.paneAgentStatus, [paneId]: next } };
    }),

  setPendingPaneCommand: (
    paneId: string,
    command: string,
    opts?: { submit?: boolean },
  ) => sendPendingCommand(paneId, command, "shell", opts),

  moveWorkspaceLayout: (from: WorkspaceKey, to: WorkspaceKey) =>
    set((state) => {
      if (from === to || state.workspaceLayouts[to]) return state;
      if (!state.workspaceLayouts[from]) return state;
      const moveKey = <T,>(record: Record<string, T>): Record<string, T> => {
        if (!(from in record)) return record;
        const { [from]: value, ...rest } = record;
        return { ...rest, [to]: value };
      };
      const movesActive = selectActiveWorkspaceKey(state) === from;
      return {
        workspaceLayouts: moveKey(state.workspaceLayouts),
        mountedWorkspaces: moveKey(state.mountedWorkspaces),
        layoutVersions: moveKey(state.layoutVersions),
        viewports: moveKey(state.viewports),
        claims: moveKey(state.claims),
        ...(movesActive && { activeWorkspaceHostId: parseWorkspaceKey(to).hostId }),
      };
    }),

  /**
   * Forget a workspace whose worktree is going away.
   *
   * Local only: the user is already looking somewhere else and its panes
   * must unmount now. Ending them is the server's — `removeWorktree` calls
   * `LayoutStore.remove`, whose `removed` broadcast drops any copy that is
   * left, here and in every other renderer.
   */
  removeWorkspaceLayout: (workspacePath: WorkspaceKey) =>
    set((state) => withoutWorkspace(state, workspacePath)),

  // ── Panel operations ──

  splitPanel: (direction: SplitDirection) => {
    const ctx = getActivePanelContext(get());
    if (!ctx) return;
    leaveTasksView();
    // A panel's only tab stays where it is — moving it out would empty the
    // panel, and the reducer removes an emptied panel — so the split opens a
    // fresh terminal beside it instead.
    if (ctx.panel.tabs.length === 1) {
      sendLayoutCommand(ctx.path, {
        type: "split-panel-with-new-tab",
        tab: createTab(),
        direction,
        newPanelId: newPanelId(),
        sourcePanelId: ctx.panel.id,
      });
      return;
    }
    sendLayoutCommand(ctx.path, {
      type: "split-panel",
      panelId: ctx.panel.id,
      direction,
      newPanelId: newPanelId(),
      // The selected tab moves into the new panel.
      tabId: selectSelectedTabId(get(), ctx.panel.id, ctx.path) ?? undefined,
    });
  },

  closePanel: (panelId: string) => {
    const path = activeLayoutKey(get());
    if (!path) return;
    sendClosingCommand(path, { type: "close-panel", panelId });
  },

  // Runs on every click inside a panel (LeafPanel onClick): an already-active
  // panel keeps the same state, so nothing re-renders (see `orSame`).
  focusPanel: (panelId: string) =>
    set((state) => {
      const path = activeLayoutKey(state);
      if (!path) return state;
      if (!state.workspaceLayouts[path]?.panels[panelId]) return state;
      return orSame(
        state,
        withViewport(state, path, (vp) => ({
          ...vp,
          activePanelId: panelId,
        })),
      );
    }),

  focusNextPanel: () => set((state) => orSame(state, stepPanel(state, nextPanelId))),

  focusPrevPanel: () => set((state) => orSame(state, stepPanel(state, prevPanelId))),

  updatePanelSplitRatio: (firstPanelId: string, ratio: number) => {
    const path = activeLayoutKey(get());
    if (!path) return;
    sendLayoutCommand(path, {
      type: "update-panel-ratio",
      firstPanelId,
      ratio,
    });
  },

  moveTabToPanel: (tabId: string, targetPanelId: string) => {
    const path = activeLayoutKey(get());
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
    const path = activeLayoutKey(get());
    if (!path) return;
    sendLayoutCommand(path, {
      type: "split-panel-with-tab",
      tabId,
      targetPanelId,
      direction,
      newPanelId: newPanelId(),
    });
  },

  // A tab dropped onto another tab stops being a tab: its whole pane subtree
  // becomes one side of a split of the target's. No ids are minted — the
  // panes it already has come along.
  mergeTabIntoTab: (sourceTabId: string, targetTabId: string) => {
    const path = activeLayoutKey(get());
    if (!path || sourceTabId === targetTabId) return;
    sendLayoutCommand(path, {
      type: "merge-tab-into-tab",
      sourceTabId,
      targetTabId,
    });
  },

  updateSplitRatio: (firstPaneId: string, ratio: number) => {
    const path = activeLayoutKey(get());
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

  initWorktreeSetup: (wsPathHint: string) =>
    set((state) => {
      const baseSteps: SetupStep[] = [
        "prune",
        "fetch",
        "create-worktree",
        "persist",
        "switch",
      ];
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

// Where a pane lives, for the bridge router: the workspace whose
// layout holds it, whose key names its host.
provideHostLookups({
  paneWorkspace: (paneId) => workspaceOfPane(useAppStore.getState(), paneId),
});

// ── The server's broadcasts land here ──
//
// Installed at import time, which is before anything can call
// `loadPersistedLayout`: a change that happens between the read and its
// resolution is delivered, and the version guard drops it if the read already
// had it.
//
// Every renderer, detached windows included: a detached window
// is a viewport with a claim on one tab of the *shared* layout, not a second
// store holding a tab of its own, so it hears about the workspace exactly
// like the primary does and shows the one tab it holds.
//
// Called bare, not deferred: both entry points install `window.electronAPI`
// as the side effect of a module imported *before* `./App` —
// `bridge/install-desktop.ts` on the desktop, `bridge/install-web.ts` on the
// web — and this file is only ever reached through
// `./App`. By the time this line runs, on either platform,
// `window.electronAPI` already exists. (This call used to be wrapped in a
// `queueMicrotask` to paper over the web side of that not being true yet;
// it is true now, so the wrapper is dead weight.)
window.electronAPI?.layout?.onChanged?.(applyLayoutChanged);

// A reconnected browser missed whatever was broadcast while its socket was
// down: re-read every workspace and merge it the way the boot
// read does, minus the boot's own effects — `layoutLoaded`, and the viewport
// file's selections (a resync repairs the local viewport, never replaces
// it). Picking the active workspace and reconciling stale agents are
// `App.tsx`'s, after the boot read, and are not re-run either; `App.tsx`
// registers this for the resync, beside the boot read.
export async function resyncLayout(): Promise<void> {
  try {
    await loadLayoutSnapshot(async () => {
      const entries = await window.electronAPI?.layout?.getAll?.();
      return entries && { entries };
    });
  } catch (err) {
    console.error("[layout] failed to resync the layout:", err);
  }
}

// A pane's title, off the command channel — a route, an MCP
// call, or another renderer's own edit, fed into the same sink an OSC title
// write already uses.
window.electronAPI?.layout?.onPaneTitle?.(({ paneId, title }) => {
  useAppStore.getState().setPaneTitleFromStream(paneId, title);
});

// ── This renderer's viewport, out to its file and to the host ──
//
// One subscription for both: the file is what this renderer reopens on, the
// report is what the *host* hands a renderer that has never seen the
// workspace. Both are debounced or fire-and-forget, because a selection
// changes on every arrow key and neither destination is on the render path.
useAppStore.subscribe((state, previous) => {
  if (
    state.viewports === previous.viewports &&
    state.activeWorkspacePath === previous.activeWorkspacePath &&
    state.activeWorkspaceHostId === previous.activeWorkspaceHostId
  ) {
    return;
  }
  scheduleViewportSave();
  for (const [workspacePath, viewport] of Object.entries(state.viewports)) {
    if (previous.viewports[workspacePath] === viewport) continue;
    reportViewport(workspacePath, viewport);
  }
});

// ── Agent status ──
//
// Main's Status reconciler is the one decider of every pane's Agent status;
// the renderer only displays what it publishes. `onStatus` keeps every
// window's cache live; `getPaneStatuses` primes a window that starts (or a
// detached/popout window that opens, or a reload) after some panes' statuses
// were already published, with nothing to replay otherwise, and re-reads them
// on a bridge resync — the held statuses are the stale ones then. A status
// published while that read is in flight is newer than it for its pane.
// Deferred a microtask for the same reason as `layout.onChanged` above.
queueMicrotask(() => {
  const agents = window.electronAPI?.agents;
  if (!agents?.onStatus) return;
  const set = (update: PaneAgentStatusUpdate): void =>
    useAppStore.getState().setPaneAgentStatus(update);
  // A push is newer than an in-flight read for *its* pane only: the read
  // still lands for every other pane, so one busy agent cannot starve the
  // rest of their catch-up.
  const reads = new Set<Set<string>>();
  agents.onStatus((update) => {
    for (const pushed of reads) pushed.add(update.paneId);
    set(update);
  });
  bootAndResync(async () => {
    const pushed = new Set<string>();
    reads.add(pushed);
    try {
      // An older preload has no read; the live stream alone keeps the cache.
      const updates = (await agents.getPaneStatuses?.()) ?? [];
      for (const update of updates) {
        if (!pushed.has(update.paneId)) set(update);
      }
    } finally {
      reads.delete(pushed);
    }
  });
});
