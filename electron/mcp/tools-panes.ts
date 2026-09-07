/**
 * MCP tools for pane and layout management: split panes, open terminal/browser
 * tabs, focus and close panes, plus the wider tab/pane control surface (select,
 * pin, reorder, move, extract, reopen) and workspace switching. See ADR-149,
 * ADR-171.
 */

import { resolveWorkspacePath } from "./context";
// Type-only: erased at compile time, so the MCP process stays Electron-free.
import type { LayoutSnapshot } from "../../src/store/layout-snapshot";
import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

/**
 * The pane this MCP process's caller is running in, read from the environment
 * `electron/pty.ts` sets when launching a Manor-managed terminal. Absent for
 * clients not launched from a Manor PTY.
 */
const callerPaneId = (): string | undefined =>
  process.env.MANOR_PANE_ID || undefined;

// ── Formatting ──

/**
 * Render the snapshot as an indented tree. Exactly one tab can print `[active]`
 * and exactly one pane `[focused]` — both are compared against the snapshot's
 * single top-level truth, not against per-panel or per-tab state.
 */
export function formatLayoutSnapshot(snapshot: LayoutSnapshot): string {
  if (snapshot.tabs.length === 0) {
    return `${snapshot.workspacePath}\n  (no tabs)`;
  }
  const lines = [snapshot.workspacePath];
  for (const tab of snapshot.tabs) {
    const activeMark = tab.tabId === snapshot.activeTabId ? " [active]" : "";
    lines.push(`  ${tab.title} (tabId: ${tab.tabId})${activeMark}`);
    for (const pane of tab.panes) {
      const focusedMark =
        pane.paneId === snapshot.focusedPaneId ? " [focused]" : "";
      const urlPart = pane.url ? ` ${pane.url}` : "";
      lines.push(
        `    - ${pane.contentType} (paneId: ${pane.paneId})${urlPart}${focusedMark}`,
      );
    }
  }
  return lines.join("\n");
}

// ── Tool definitions ──

const tools: ToolDef[] = [
  {
    name: "list_panes",
    description:
      "List every tab and pane in the active workspace as an indented tree, marking the active tab and the focused pane. Every pane line includes its paneId, which is the join key for split_pane, focus_pane, close_pane, read_session (reads a terminal pane's scrollback), and all webview tools (navigate, screenshot_webview, get_dom, click_element, type_text, get_console_logs).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "split_pane",
    description:
      "Split an existing pane in two. 'paneId' defaults to the pane this agent is running in. 'direction' controls the split axis: 'horizontal' places the new pane side-by-side, 'vertical' stacks it above/below. 'position' defaults to 'second' (new pane goes right/below); use 'first' to put it left/above. 'contentType' defaults to 'terminal'; 'url' applies only when contentType is 'browser'; 'command' auto-runs in a new 'terminal' pane. Returns the new pane's paneId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description:
            "Pane to split. Defaults to the pane this agent is running in.",
        },
        direction: {
          type: "string",
          enum: ["horizontal", "vertical"],
          description:
            "'horizontal' splits side-by-side; 'vertical' stacks above/below.",
        },
        position: {
          type: "string",
          enum: ["first", "second"],
          description:
            "Where the new pane goes relative to the split. 'second' (default) is right/below; 'first' is left/above.",
        },
        contentType: {
          type: "string",
          enum: ["terminal", "browser", "diff", "agent"],
          description: "Content type for the new pane. Defaults to 'terminal'.",
        },
        url: {
          type: "string",
          description:
            "URL to load. Only applies when contentType is 'browser'.",
        },
        command: {
          type: "string",
          description:
            "Command to auto-run. Only applies to a 'terminal' pane.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "new_terminal",
    description:
      "Open a new terminal tab, optionally in a specific workspace and running a command. Returns the new tabId and paneId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace to open the tab in. Defaults to the workspace this agent is running in.",
        },
        command: {
          type: "string",
          description: "Command to auto-run in the new terminal.",
        },
      },
    },
  },
  {
    name: "new_browser",
    description:
      "Open a new browser tab pointed at 'url', optionally in a specific workspace. Returns the new tabId and paneId; the paneId is usable with navigate, screenshot_webview, get_dom, click_element, type_text, and get_console_logs. The pane needs a moment to mount, so a webview call issued immediately after may 404 — retry once.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL to load in the new browser tab.",
        },
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace to open the tab in. Defaults to the workspace this agent is running in.",
        },
        background: {
          type: "boolean",
          description: "Open the tab without switching focus to it.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "focus_pane",
    description: "Focus a pane by its paneId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: { type: "string", description: "Pane to focus." },
      },
      required: ["paneId"],
    },
  },
  {
    name: "close_pane",
    description: "Close a pane by its paneId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: { type: "string", description: "Pane to close." },
      },
      required: ["paneId"],
    },
  },
  {
    name: "select_tab",
    description: "Select a tab by its tabId, switching to it in its panel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tabId: { type: "string", description: "Tab to select." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "next_tab",
    description:
      "Select the next tab in the active panel, wrapping around from the last tab to the first.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "prev_tab",
    description:
      "Select the previous tab in the active panel, wrapping around from the first tab to the last.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "close_tab",
    description:
      "Close a tab by its tabId, terminating every pane inside it. Closes unconditionally: unlike the in-app close button, there is no confirmation dialog over MCP even when a pane inside the tab has an active agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tabId: { type: "string", description: "Tab to close." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "close_other_tabs",
    description:
      "Close every other unpinned tab in the same panel as tabId, leaving it and any pinned tabs open.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tabId: {
          type: "string",
          description:
            "Tab to keep. Every other unpinned tab in its panel is closed.",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "close_tabs_to_right",
    description:
      "Close every unpinned tab positioned after tabId in its panel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tabId: {
          type: "string",
          description: "Tabs after this one in its panel are closed.",
        },
      },
      required: ["tabId"],
    },
  },
  {
    name: "pin_tab",
    description:
      "Toggle whether a tab is pinned. Returns the tab's new pinned state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tabId: { type: "string", description: "Tab to pin or unpin." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "duplicate_tab",
    description:
      "Duplicate a tab, including its full pane split layout. Returns the new tab's id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tabId: { type: "string", description: "Tab to duplicate." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "reorder_tabs",
    description:
      "Reorder the tabs in the active panel. 'tabIds' must contain exactly the panel's current tabs, listed in the desired order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tabIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Every tab currently in the active panel, in the desired order.",
        },
      },
      required: ["tabIds"],
    },
  },
  {
    name: "open_diff",
    description:
      "Open the active workspace's diff tab, or focus it if one is already open. Returns the diff tab's id.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "set_pane_title",
    description:
      "Set a custom title for a pane, overriding the one derived from its content (shell command, page title, etc).",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: { type: "string", description: "Pane to retitle." },
        title: { type: "string", description: "New title." },
      },
      required: ["paneId", "title"],
    },
  },
  {
    name: "clear_pane_title",
    description:
      "Clear a pane's custom title, reverting to the one derived from its content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: { type: "string", description: "Pane to clear the title of." },
      },
      required: ["paneId"],
    },
  },
  {
    name: "move_pane",
    description:
      "Move a pane out of its current split and into a new split next to another pane. 'direction' and 'position' work exactly as in split_pane, but describe where the moved pane lands relative to 'targetPaneId'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: { type: "string", description: "Pane to move." },
        targetPaneId: {
          type: "string",
          description: "Pane the moved pane will be split next to.",
        },
        direction: {
          type: "string",
          enum: ["horizontal", "vertical"],
          description:
            "'horizontal' splits side-by-side; 'vertical' stacks above/below.",
        },
        position: {
          type: "string",
          enum: ["first", "second"],
          description:
            "Where the moved pane goes relative to the split. 'second' (default) is right/below; 'first' is left/above.",
        },
      },
      required: ["paneId", "targetPaneId", "direction"],
    },
  },
  {
    name: "extract_pane_to_tab",
    description:
      "Pull a pane out of its current split and into its own new tab. 'targetPanelId' moves it into a specific panel; defaults to the pane's current panel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: { type: "string", description: "Pane to extract." },
        targetPanelId: {
          type: "string",
          description:
            "Panel to extract the pane into. Defaults to the pane's current panel.",
        },
      },
      required: ["paneId"],
    },
  },
  {
    name: "reopen_closed_pane",
    description:
      "Reopen the most recently closed pane or tab in the active workspace. Errors if nothing has been closed.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "focus_next_pane",
    description:
      "Focus the next pane in the active tab, cycling through its panes.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "focus_prev_pane",
    description:
      "Focus the previous pane in the active tab, cycling through its panes.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "set_active_workspace",
    description:
      "Switch the app's active workspace by filesystem path. Defaults to the workspace this agent is running in.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace to switch to. Defaults to the workspace this agent is running in.",
        },
      },
    },
  },
];

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_panes(_args, http) {
    const snapshot = (await http.get("/panes")) as LayoutSnapshot;
    return text(formatLayoutSnapshot(snapshot));
  },

  async split_pane(args, http) {
    const paneId = (args.paneId as string | undefined) ?? callerPaneId();
    const body: Record<string, unknown> = { direction: args.direction };
    if (paneId !== undefined) body.paneId = paneId;
    if (args.position !== undefined) body.position = args.position;
    if (args.contentType !== undefined) body.contentType = args.contentType;
    if (args.url !== undefined) body.url = args.url;
    if (args.command !== undefined) body.command = args.command;
    const result = (await http.post("/panes/split", body)) as {
      paneId: string;
    };
    const target = paneId ?? "the focused pane";
    return text(
      `Split ${target} ${args.direction}. New pane: ${result.paneId}`,
    );
  },

  async new_terminal(args, http) {
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    const body: Record<string, unknown> = {
      contentType: "terminal",
      workspacePath,
    };
    if (args.command !== undefined) body.command = args.command;
    const result = (await http.post("/tabs", body)) as {
      tabId: string;
      paneId: string;
    };
    return text(
      `Opened terminal tab ${result.tabId} (pane: ${result.paneId}).`,
    );
  },

  async new_browser(args, http) {
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    const body: Record<string, unknown> = {
      contentType: "browser",
      url: args.url,
      workspacePath,
    };
    if (args.background !== undefined) body.background = args.background;
    const result = (await http.post("/tabs", body)) as {
      tabId: string;
      paneId: string;
    };
    return text(
      `Opened browser tab ${result.tabId} at ${args.url} (pane: ${result.paneId}).`,
    );
  },

  async focus_pane(args, http) {
    await http.post(
      `/panes/${encodeURIComponent(args.paneId as string)}/focus`,
    );
    return text(`Focused pane ${args.paneId}.`);
  },

  async close_pane(args, http) {
    await http.del(`/panes/${encodeURIComponent(args.paneId as string)}`);
    return text(`Closed pane ${args.paneId}.`);
  },

  async select_tab(args, http) {
    await http.post(`/tabs/${encodeURIComponent(args.tabId as string)}/select`);
    return text(`Selected tab ${args.tabId}.`);
  },

  async next_tab(_args, http) {
    const result = (await http.post("/tabs/next")) as { tabId: string };
    return text(`Selected tab ${result.tabId}.`);
  },

  async prev_tab(_args, http) {
    const result = (await http.post("/tabs/prev")) as { tabId: string };
    return text(`Selected tab ${result.tabId}.`);
  },

  async close_tab(args, http) {
    await http.post(`/tabs/${encodeURIComponent(args.tabId as string)}/close`);
    return text(`Closed tab ${args.tabId}.`);
  },

  async close_other_tabs(args, http) {
    await http.post(
      `/tabs/${encodeURIComponent(args.tabId as string)}/close-others`,
    );
    return text(`Closed every other tab in ${args.tabId}'s panel.`);
  },

  async close_tabs_to_right(args, http) {
    await http.post(
      `/tabs/${encodeURIComponent(args.tabId as string)}/close-right`,
    );
    return text(`Closed every tab to the right of ${args.tabId}.`);
  },

  async pin_tab(args, http) {
    const result = (await http.post(
      `/tabs/${encodeURIComponent(args.tabId as string)}/pin`,
    )) as { tabId: string; pinned: boolean };
    return text(
      `Tab ${result.tabId} is now ${result.pinned ? "pinned" : "unpinned"}.`,
    );
  },

  async duplicate_tab(args, http) {
    const result = (await http.post(
      `/tabs/${encodeURIComponent(args.tabId as string)}/duplicate`,
    )) as { tabId: string };
    return text(`Duplicated tab ${args.tabId} as ${result.tabId}.`);
  },

  async reorder_tabs(args, http) {
    await http.post("/tabs/reorder", { tabIds: args.tabIds });
    return text("Reordered tabs.");
  },

  async open_diff(_args, http) {
    const result = (await http.post("/tabs/diff")) as { tabId: string };
    return text(`Opened diff tab ${result.tabId}.`);
  },

  async set_pane_title(args, http) {
    await http.post(
      `/panes/${encodeURIComponent(args.paneId as string)}/title`,
      {
        title: args.title,
      },
    );
    return text(`Set pane ${args.paneId}'s title to "${args.title}".`);
  },

  async clear_pane_title(args, http) {
    await http.post(
      `/panes/${encodeURIComponent(args.paneId as string)}/title`,
      {
        title: null,
      },
    );
    return text(`Cleared pane ${args.paneId}'s title.`);
  },

  async move_pane(args, http) {
    const body: Record<string, unknown> = {
      targetPaneId: args.targetPaneId,
      direction: args.direction,
    };
    if (args.position !== undefined) body.position = args.position;
    await http.post(
      `/panes/${encodeURIComponent(args.paneId as string)}/move`,
      body,
    );
    return text(`Moved pane ${args.paneId} next to ${args.targetPaneId}.`);
  },

  async extract_pane_to_tab(args, http) {
    const body: Record<string, unknown> = {};
    if (args.targetPanelId !== undefined)
      body.targetPanelId = args.targetPanelId;
    const result = (await http.post(
      `/panes/${encodeURIComponent(args.paneId as string)}/extract`,
      body,
    )) as { tabId: string };
    return text(`Extracted pane ${args.paneId} into tab ${result.tabId}.`);
  },

  async reopen_closed_pane(_args, http) {
    await http.post("/panes/reopen");
    return text("Reopened the most recently closed pane.");
  },

  async focus_next_pane(_args, http) {
    const result = (await http.post("/panes/focus-next")) as {
      paneId: string;
    };
    return text(`Focused pane ${result.paneId}.`);
  },

  async focus_prev_pane(_args, http) {
    const result = (await http.post("/panes/focus-prev")) as {
      paneId: string;
    };
    return text(`Focused pane ${result.paneId}.`);
  },

  async set_active_workspace(args, http) {
    const workspacePath = await resolveWorkspacePath(
      http,
      args.workspacePath as string | undefined,
    );
    await http.post("/workspaces/active", { workspacePath });
    return text(`Switched to workspace ${workspacePath}.`);
  },
};

export const panesModule: ToolModule = { tools, handlers };
