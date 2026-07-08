/**
 * MCP tools for pane and layout management: split panes, open terminal/browser
 * tabs, focus and close panes. See ADR-149.
 */

// Type-only: erased at compile time, so the MCP process stays Electron-free.
import type { LayoutSnapshot } from "../../src/store/layout-snapshot";
import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

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
      "List every tab and pane in the active workspace as an indented tree, marking the active tab and the focused pane. Every pane line includes its paneId, which is the join key for split_pane, focus_pane, close_pane, and all webview tools (navigate, screenshot_webview, get_dom, click_element, type_text, get_console_logs).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "split_pane",
    description:
      "Split an existing pane in two. 'paneId' defaults to the currently focused pane. 'direction' controls the split axis: 'horizontal' places the new pane side-by-side, 'vertical' stacks it above/below. 'position' defaults to 'second' (new pane goes right/below); use 'first' to put it left/above. 'contentType' defaults to 'terminal'; 'url' applies only when contentType is 'browser'; 'command' auto-runs in a new 'terminal' pane. Returns the new pane's paneId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane to split. Defaults to the focused pane.",
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
          enum: ["terminal", "browser", "diff", "task"],
          description: "Content type for the new pane. Defaults to 'terminal'.",
        },
        url: {
          type: "string",
          description: "URL to load. Only applies when contentType is 'browser'.",
        },
        command: {
          type: "string",
          description: "Command to auto-run. Only applies to a 'terminal' pane.",
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
            "Filesystem path of the workspace to open the tab in. Defaults to the active workspace.",
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
        url: { type: "string", description: "URL to load in the new browser tab." },
        workspacePath: {
          type: "string",
          description:
            "Filesystem path of the workspace to open the tab in. Defaults to the active workspace.",
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
];

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_panes(_args, http) {
    const snapshot = (await http.get("/panes")) as LayoutSnapshot;
    return text(formatLayoutSnapshot(snapshot));
  },

  async split_pane(args, http) {
    const body: Record<string, unknown> = { direction: args.direction };
    if (args.paneId !== undefined) body.paneId = args.paneId;
    if (args.position !== undefined) body.position = args.position;
    if (args.contentType !== undefined) body.contentType = args.contentType;
    if (args.url !== undefined) body.url = args.url;
    if (args.command !== undefined) body.command = args.command;
    const result = (await http.post("/panes/split", body)) as {
      paneId: string;
    };
    const target = args.paneId ?? "the focused pane";
    return text(
      `Split ${target} ${args.direction}. New pane: ${result.paneId}`,
    );
  },

  async new_terminal(args, http) {
    const body: Record<string, unknown> = { contentType: "terminal" };
    if (args.workspacePath !== undefined) body.workspacePath = args.workspacePath;
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
    const body: Record<string, unknown> = {
      contentType: "browser",
      url: args.url,
    };
    if (args.workspacePath !== undefined) body.workspacePath = args.workspacePath;
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
    await http.post(`/panes/${encodeURIComponent(args.paneId as string)}/focus`);
    return text(`Focused pane ${args.paneId}.`);
  },

  async close_pane(args, http) {
    await http.del(`/panes/${encodeURIComponent(args.paneId as string)}`);
    return text(`Closed pane ${args.paneId}.`);
  },
};

export const panesModule: ToolModule = { tools, handlers };
