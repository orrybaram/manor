/**
 * Renderer-side handlers for the correlated "app-command" channel.
 *
 * ADR-179 D5 shrank this to exactly the commands that still need a window:
 * **viewport** — focus, select, next/prev tab, activate a workspace — because
 * the server has no answer to "which window?" (D3). Every structural command
 * (split, close, move, new tab, reopen, …) moved to
 * `electron/routes/panes.ts`, which drives `LayoutStore` directly and needs no
 * renderer at all; `start-agent` followed it into `electron/routes/agents.ts`
 * once the pending launch line had a server-side home (ticket 11).
 *
 * Main cannot mutate the pane/layout store, so it sends a command and awaits a
 * reply (see `requestRenderer` in electron/renderer-bridge.ts). This module is
 * the dispatch table for those commands: a pure map over
 * `useAppStore.getState()`, deliberately free of React so it stays
 * unit-testable and so `App.tsx` does not grow a branch per MCP tool.
 *
 * Handlers **throw** on bad input. `App.tsx` converts a throw into
 * `{ ok: false, error }`, which main maps onto an HTTP status.
 *
 * Note the one legacy command `run-setup-script` is *not* here: it is
 * fire-and-forget, and it depends on `App.tsx`'s callback refs.
 */

import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneOfActiveTab,
  selectSelectedTabId,
  type AppState,
  type Panel,
  type WorkspaceLayout,
} from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { hasPaneId } from "./layout/pane-tree";

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Argument parsing. Main's body parsing is untyped JSON — validate here.
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Store context lookups. Each throws rather than letting a store action no-op.
// ---------------------------------------------------------------------------

function requireActiveLayout(state: AppState): WorkspaceLayout {
  const path = state.activeWorkspacePath;
  const layout = path ? state.workspaceLayouts[path] : undefined;
  if (!layout) throw new Error("No active workspace");
  return layout;
}

function requireActivePanel(state: AppState): Panel {
  const layout = requireActiveLayout(state);
  const panelId = selectActivePanelId(state);
  const panel = panelId ? layout.panels[panelId] : undefined;
  if (!panel) throw new Error("No active panel");
  return panel;
}

/** The pane this window has the keyboard in, or a throw. */
function requireFocusedPaneId(state: AppState): string {
  const paneId = selectFocusedPaneOfActiveTab(state);
  if (!paneId) throw new Error("No focused pane");
  return paneId;
}

/** True when `paneId` lives anywhere in the workspace, across every panel. */
function layoutHasPane(layout: WorkspaceLayout, paneId: string): boolean {
  return Object.values(layout.panels).some((panel) =>
    panel.tabs.some((tab) => hasPaneId(tab.rootNode, paneId)),
  );
}

/**
 * A workspace is addressable if the store already holds a layout for it, or a
 * loaded project claims it. `setActiveWorkspace` happily invents an empty
 * layout for any string, which would silently create the tab nowhere useful.
 */
function isKnownWorkspace(state: AppState, path: string): boolean {
  if (state.workspaceLayouts[path]) return true;
  return useProjectStore
    .getState()
    .projects.some((project) =>
      project.workspaces.some((w) => w.path === path),
    );
}

// ---------------------------------------------------------------------------
// Viewport handlers (ADR-179 D3) — what this window is looking at. No
// `LayoutCommand` goes out; the server has no notion of "which window?".
// ---------------------------------------------------------------------------

function focusPane(args: Record<string, unknown>): { ok: true } {
  const paneId = requireString(args, "paneId");
  const state = useAppStore.getState();
  const layout = requireActiveLayout(state);
  if (!layoutHasPane(layout, paneId)) {
    throw new Error(`Unknown paneId: ${paneId}`);
  }
  state.focusPane(paneId);
  return { ok: true };
}

function selectTab(args: Record<string, unknown>): { tabId: string } {
  const tabId = requireString(args, "tabId");
  const state = useAppStore.getState();
  const panel = requireActivePanel(state);
  // `selectTab` selects a tab wherever it is, so a tabId from another panel
  // would move the keyboard to that panel — which is not what an MCP
  // `select_tab` against "the active panel" means. Validate against the
  // active panel specifically, not the layout.
  if (!panel.tabs.some((t) => t.id === tabId)) {
    throw new Error(`Unknown tabId: ${tabId}`);
  }
  state.selectTab(tabId);
  return { tabId };
}

function selectAdjacentTab(direction: "next" | "prev"): { tabId: string } {
  const state = useAppStore.getState();
  requireActivePanel(state);
  if (direction === "next") state.selectNextTab();
  else state.selectPrevTab();
  const fresh = useAppStore.getState();
  const tabId = selectSelectedTabId(fresh, selectActivePanelId(fresh));
  if (!tabId) throw new Error("No tabs in the active panel");
  return { tabId };
}

function nextTab(): { tabId: string } {
  return selectAdjacentTab("next");
}

function prevTab(): { tabId: string } {
  return selectAdjacentTab("prev");
}

function focusAdjacentPane(direction: "next" | "prev"): { paneId: string } {
  const state = useAppStore.getState();
  requireFocusedPaneId(state);
  if (direction === "next") state.focusNextPane();
  else state.focusPrevPane();
  return { paneId: requireFocusedPaneId(useAppStore.getState()) };
}

function focusNextPane(): { paneId: string } {
  return focusAdjacentPane("next");
}

function focusPrevPane(): { paneId: string } {
  return focusAdjacentPane("prev");
}

function setActiveWorkspace(args: Record<string, unknown>): {
  workspacePath: string;
} {
  const workspacePath = requireString(args, "workspacePath");
  const state = useAppStore.getState();
  if (!isKnownWorkspace(state, workspacePath)) {
    throw new Error(`Unknown workspace: ${workspacePath}`);
  }
  state.setActiveWorkspace(workspacePath);
  return { workspacePath };
}

/**
 * Every correlated command main may send. An unrecognised `cmd` must be
 * rejected by the caller, not silently resolved — see `App.tsx`.
 */
export const appCommandHandlers: Record<string, Handler> = {
  "focus-pane": focusPane,
  "select-tab": selectTab,
  "next-tab": nextTab,
  "prev-tab": prevTab,
  "focus-next-pane": focusNextPane,
  "focus-prev-pane": focusPrevPane,
  "set-active-workspace": setActiveWorkspace,
};
