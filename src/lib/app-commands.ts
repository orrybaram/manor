/**
 * Renderer-side handlers for the correlated "app-command" channel.
 *
 * Main cannot mutate the pane/layout store, so it sends a command and awaits a
 * reply (see `requestRenderer` in electron/renderer-bridge.ts). This module is
 * the dispatch table for those commands: a pure map over
 * `useAppStore.getState()`, deliberately free of React so it stays
 * unit-testable and so `App.tsx` does not grow a branch per MCP tool.
 *
 * Handlers **throw** on bad input. `App.tsx` converts a throw into
 * `{ ok: false, error }`, which main maps onto an HTTP status. Several store
 * actions no-op silently when their target does not exist (`splitPaneAt`'s
 * `if (!tab) return state;`); a tool that does nothing and reports success is
 * worse than one that errors, so every handler validates before it writes.
 *
 * Note the two legacy commands `start-agent` and `run-setup-script` are *not*
 * here: they are fire-and-forget, and they depend on `App.tsx`'s callback refs.
 */

import {
  useAppStore,
  type AppState,
  type Panel,
  type WorkspaceLayout,
} from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { layoutSnapshot } from "../store/layout-snapshot";
import { hasPaneId, type SplitDirection } from "../store/pane-tree";

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** Content types a pane may hold. "task" is a terminal that auto-runs a command. */
const SPLIT_CONTENT_TYPES = ["terminal", "browser", "diff", "task"] as const;
type SplitContentType = (typeof SPLIT_CONTENT_TYPES)[number];

/** Tabs can only be created as terminals or browsers (diff tabs have `addDiffTab`). */
const TAB_CONTENT_TYPES = ["terminal", "browser"] as const;
type TabContentType = (typeof TAB_CONTENT_TYPES)[number];

const SPLIT_DIRECTIONS = ["horizontal", "vertical"] as const;
const SPLIT_POSITIONS = ["first", "second"] as const;
type SplitPosition = (typeof SPLIT_POSITIONS)[number];

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

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Argument ${key} must be a boolean`);
  }
  return value;
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `Argument ${key} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

function parseOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return parseEnum(value, allowed, key);
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
  const panel = layout.panels[layout.activePanelId];
  if (!panel) throw new Error("No active panel");
  return panel;
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
    .projects.some((project) => project.workspaces.some((w) => w.path === path));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function listPanes(): unknown {
  const snapshot = layoutSnapshot(useAppStore.getState());
  if (!snapshot) throw new Error("No active workspace");
  return snapshot;
}

function splitPane(args: Record<string, unknown>): { paneId: string } {
  const state = useAppStore.getState();
  // Only used to default `paneId` to the active panel's focused pane; the
  // pane itself may legitimately live in any panel. This is the fallback
  // default for non-MCP callers — the MCP layer supplies the caller's own
  // pane (electron/mcp/tools-panes.ts) before reaching here.
  const panel = requireActivePanel(state);

  const requestedPaneId = optionalString(args, "paneId");
  const target =
    requestedPaneId ??
    panel.tabs.find((t) => t.id === panel.selectedTabId)?.focusedPaneId;
  if (!target) throw new Error("No focused pane to split");

  const direction = parseEnum<SplitDirection>(
    args.direction,
    SPLIT_DIRECTIONS,
    "direction",
  );
  const position =
    parseOptionalEnum<SplitPosition>(args.position, SPLIT_POSITIONS, "position") ??
    "second";
  const contentType = parseOptionalEnum<SplitContentType>(
    args.contentType,
    SPLIT_CONTENT_TYPES,
    "contentType",
  );
  const url = optionalString(args, "url");
  const paneCommand = optionalString(args, "command");

  if (url && contentType !== "browser") {
    throw new Error("url applies only to contentType 'browser'");
  }
  if (paneCommand && (contentType === "browser" || contentType === "diff")) {
    throw new Error("command applies only to a terminal or task pane");
  }

  const paneId = state.splitPaneAt(target, direction, position, {
    contentType,
    paneCommand,
    url,
  });
  if (!paneId) throw new Error(`Unknown paneId: ${target}`);
  return { paneId };
}

function newTab(args: Record<string, unknown>): {
  tabId: string;
  paneId: string;
} {
  // 1. Parse and validate everything — no store writes above this line.
  const workspacePath = optionalString(args, "workspacePath");
  const contentType = parseEnum<TabContentType>(
    args.contentType,
    TAB_CONTENT_TYPES,
    "contentType",
  );
  const url = optionalString(args, "url");
  const command = optionalString(args, "command");
  const background = optionalBoolean(args, "background");

  if (contentType === "browser" && !url) {
    throw new Error('new-tab with contentType "browser" requires a url');
  }
  if (contentType !== "browser" && url) {
    throw new Error("url applies only to contentType 'browser'");
  }
  if (contentType !== "browser" && background !== undefined) {
    throw new Error("background applies only to contentType 'browser'");
  }

  const state = useAppStore.getState();
  if (workspacePath && !isKnownWorkspace(state, workspacePath)) {
    throw new Error(`Unknown workspace: ${workspacePath}`);
  }

  // 2. Act. Switch workspace only if requested, and always switch back —
  // `new-tab` is MCP-only; an agent that wants the user looking at its tab
  // calls `focus_pane` instead.
  const previous = state.activeWorkspacePath;
  if (workspacePath) state.setActiveWorkspace(workspacePath);
  try {
    // `setActiveWorkspace` is a synchronous `set()`; re-read to see it.
    const fresh = useAppStore.getState();
    requireActivePanel(fresh);

    let created: { tabId: string; paneId: string } | null;
    if (contentType === "browser") {
      created = fresh.addBrowserTab(url!, { background });
    } else if (command) {
      created = fresh.addTerminalTab(command);
    } else {
      created = fresh.addTab();
    }

    if (!created) throw new Error("Tab was not created");
    return created;
  } finally {
    if (workspacePath && previous && previous !== workspacePath) {
      useAppStore.getState().setActiveWorkspace(previous);
    }
  }
}

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

function closePane(args: Record<string, unknown>): { ok: true } {
  const paneId = requireString(args, "paneId");
  const state = useAppStore.getState();
  const layout = requireActiveLayout(state);
  if (!layoutHasPane(layout, paneId)) {
    throw new Error(`Unknown paneId: ${paneId}`);
  }
  state.closePaneById(paneId);
  return { ok: true };
}

/**
 * Every correlated command main may send. An unrecognised `cmd` must be
 * rejected by the caller, not silently resolved — see `App.tsx`.
 */
export const appCommandHandlers: Record<string, Handler> = {
  "list-panes": listPanes,
  "split-pane": splitPane,
  "new-tab": newTab,
  "focus-pane": focusPane,
  "close-pane": closePane,
};
