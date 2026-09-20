/**
 * Renderer-side handlers for the correlated "app-command" channel.
 *
 * ADR-179 D5 shrank this to exactly the commands that still need a window:
 * **viewport** — focus, select, next/prev tab, activate a workspace — because
 * the server has no answer to "which window?" (D3), and **start-agent**,
 * because launching one still means resolving this renderer's project store
 * and seeding a pending startup command only *this* renderer's mount effect
 * reads. Every structural command (split, close, move, new tab, reopen, …)
 * moved to `electron/routes/panes.ts`, which drives `LayoutStore` directly and
 * needs no renderer at all.
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
import { isHomePath } from "./home-path";
import { launchAgentInWorkspace } from "./agent-prompt-launch";

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

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Argument ${key} must be a string`);
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

// ---------------------------------------------------------------------------
// Agent handlers
// ---------------------------------------------------------------------------

/** True when a loaded project already claims `workspacePath`. */
function projectsKnowWorkspace(workspacePath: string): boolean {
  return useProjectStore
    .getState()
    .projects.some((p) => p.workspaces.some((w) => w.path === workspacePath));
}

/**
 * Open an agent pane in an explicitly named workspace, optionally seeded with
 * a first prompt.
 *
 * Every store read and every store write keys off the `workspacePath`
 * argument. The predecessor lived in `App.tsx` and closed over React's
 * `activeWorkspacePath`, which a same-microtask `setActiveWorkspace` could not
 * refresh: the pending command landed on the *previous* workspace while the
 * tab opened in the new one (ADR-176).
 *
 * The launch itself — selecting the workspace, resolving its command,
 * flattening and seeding the prompt, opening the tab — is
 * `launchAgentInWorkspace` in `agent-prompt-launch.ts`, shared with
 * `startAgentWithPrompt`. This handler only owns what is specific to a
 * correlated, control-server-initiated launch: refetching projects for a
 * workspace created moments ago, and reporting the created tab/pane back to
 * main.
 *
 * ADR-179 D5 kept this on the renderer channel rather than moving it beside
 * `/panes/split` and `/tabs`: `launchAgentInWorkspace` seeds a *pending
 * startup command* into this renderer's own store, read back by the pane's
 * mount effect once the broadcast lands (`useTerminalLifecycle.ts`). A route
 * that minted the tab through `LayoutStore.apply()` directly would create the
 * tab, but nothing would ever type the agent's launch command into it — that
 * seed has no server-side home. Until that gap has one, `start-agent`
 * without a window open still 503s, same as before this ticket.
 */
async function startAgent(args: Record<string, unknown>): Promise<{
  tabId: string;
  paneId: string;
  workspacePath: string;
}> {
  const workspacePath = requireString(args, "workspacePath");
  const prompt = optionalString(args, "prompt");
  const agentCommand = optionalString(args, "agentCommand");

  // A workspace created moments ago over the control server is not in the
  // store yet, and the command resolution below needs it. Refetch only when
  // the path is genuinely unknown: `requestRenderer` times out at 5s, so an
  // unconditional refetch risks reporting a successful launch as a failure.
  if (!isHomePath(workspacePath) && !projectsKnowWorkspace(workspacePath)) {
    await useProjectStore.getState().loadProjects();
  }

  const tab = launchAgentInWorkspace(workspacePath, { prompt, agentCommand });
  if (!tab) throw new Error("No active panel to open an agent in");
  return { tabId: tab.tabId, paneId: tab.paneId, workspacePath };
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
  "start-agent": startAgent,
};
