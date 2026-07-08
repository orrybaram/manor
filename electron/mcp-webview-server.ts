/**
 * MCP server for webview inspection — runs as standalone Node.js process
 * (NOT inside Electron). Proxies Claude Code tool calls to the webview
 * HTTP server running inside Manor's Electron process.
 *
 * Discovery: reads port from ~/.manor/webview-server-port
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { webviewServerPortFile } from "./paths";

// ── Port discovery ──

const PORT_FILE = webviewServerPortFile();

function readPort(): number {
  const envPort = process.env.MANOR_WEBVIEW_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  if (!fs.existsSync(PORT_FILE)) {
    console.error(
      `[mcp-manor] Port file not found at ${PORT_FILE} — is Manor running?`,
    );
    process.exit(1);
  }
  const port = parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10);
  if (isNaN(port)) {
    console.error(`[mcp-manor] Invalid port in ${PORT_FILE}`);
    process.exit(1);
  }
  return port;
}

const BASE_URL = `http://127.0.0.1:${readPort()}`;

// ── HTTP helpers ──

async function httpGet(urlPath: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${urlPath}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function httpPost(
  urlPath: string,
  body?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const init: RequestInit = {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  if (timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const res = await fetch(`${BASE_URL}${urlPath}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function httpDelete(
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: "DELETE",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Pane resolution ──

interface WebviewInfo {
  paneId: string;
  url: string;
  title: string;
}

async function resolvePaneId(paneId: string | undefined): Promise<string> {
  if (paneId) return paneId;

  const webviews = (await httpGet("/webviews")) as WebviewInfo[];
  if (webviews.length === 0) {
    throw new Error("No webviews are currently open in Manor.");
  }
  if (webviews.length === 1) {
    return webviews[0].paneId;
  }
  const listing = webviews
    .map((w) => `  - ${w.paneId}: ${w.title} (${w.url})`)
    .join("\n");
  throw new Error(`Multiple webviews open. Specify a paneId:\n${listing}`);
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: "list_webviews",
    description:
      "List all open webview panes in Manor with their id, url, and title.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "screenshot_webview",
    description: "Take a screenshot of a webview pane. Returns a PNG image.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
      },
    },
  },
  {
    name: "get_dom",
    description: "Get a simplified DOM snapshot of the webview page.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
      },
    },
  },
  {
    name: "execute_js",
    description:
      "Execute JavaScript code in the webview and return the result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
        code: { type: "string", description: "JavaScript code to execute." },
      },
      required: ["code"],
    },
  },
  {
    name: "click_element",
    description:
      "Click an element in the webview by CSS selector or coordinates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
        selector: {
          type: "string",
          description: "CSS selector of the element to click.",
        },
        x: { type: "number", description: "X coordinate to click." },
        y: { type: "number", description: "Y coordinate to click." },
      },
    },
  },
  {
    name: "type_text",
    description: "Type text into an element in the webview.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
        selector: {
          type: "string",
          description: "CSS selector of the element to type into.",
        },
        text: { type: "string", description: "Text to type." },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "navigate",
    description: "Navigate the webview to a URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
        url: { type: "string", description: "URL to navigate to." },
      },
      required: ["url"],
    },
  },
  {
    name: "get_console_logs",
    description: "Get console log entries from the webview.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
      },
    },
  },
  {
    name: "get_url",
    description: "Get the current URL of the webview.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
      },
    },
  },
  {
    name: "pick_element",
    description:
      "Activate element picker in a webview — the user selects an element and its context is returned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
      },
    },
  },
  {
    name: "get_element_context",
    description:
      "Get detailed context for a DOM element by CSS selector, without requiring user interaction.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
        selector: {
          type: "string",
          description: "CSS selector of the element to inspect.",
        },
      },
      required: ["selector"],
    },
  },

  // ── Project & workspace management ──
  {
    name: "list_projects",
    description:
      "List all projects in Manor with their IDs, names, paths, and workspace counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_project",
    description:
      "Get full details for a project including all of its workspaces.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "add_project",
    description: "Add a new project to Manor by name and directory path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Display name for the project." },
        path: {
          type: "string",
          description: "Absolute path to the project directory.",
        },
      },
      required: ["name", "path"],
    },
  },
  {
    name: "create_workspace",
    description:
      "Create a new workspace (git worktree) in a project. Creates a new branch by default, or checks out an existing one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        name: {
          type: "string",
          description: "Workspace name (also used as the branch name unless 'branch' is given).",
        },
        branch: {
          type: "string",
          description: "Branch name, if different from the workspace name.",
        },
        baseBranch: {
          type: "string",
          description: "Base branch/ref to branch from (e.g. 'origin/main').",
        },
        useExistingBranch: {
          type: "boolean",
          description: "Check out an existing branch instead of creating a new one.",
        },
      },
      required: ["projectId", "name"],
    },
  },
  {
    name: "list_workspaces",
    description: "List all workspaces (git worktrees) for a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "remove_workspace",
    description: "Remove a workspace (git worktree) from a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        worktreePath: {
          type: "string",
          description: "Filesystem path of the workspace to remove.",
        },
        deleteBranch: {
          type: "boolean",
          description: "Also delete the workspace's git branch.",
        },
      },
      required: ["projectId", "worktreePath"],
    },
  },

  // ── Issues & agents ──
  {
    name: "list_issues",
    description: "List a project's GitHub issues (assigned to you by default).",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        filter: {
          type: "string",
          description: "Which issues to list: 'assigned' (default) or 'all'.",
        },
        state: {
          type: "string",
          description: "Issue state: 'open', 'closed', or 'all'.",
        },
        limit: {
          type: "number",
          description: "Maximum number of issues to return.",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "start_agent",
    description:
      "Launch an agent session in a workspace, optionally with an initial prompt. Fire-and-forget: returns once the launch is dispatched.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        workspacePath: {
          type: "string",
          description: "Filesystem path of the workspace to launch the agent in.",
        },
        prompt: {
          type: "string",
          description: "Optional initial prompt for the agent.",
        },
      },
      required: ["projectId", "workspacePath"],
    },
  },
  {
    name: "batch_create_workspaces",
    description:
      "Create one workspace per GitHub issue and (by default) launch an agent in each — fan a backlog out into parallel agent workspaces.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: { type: "string", description: "Project ID." },
        issues: {
          type: "array",
          items: { type: "number" },
          description: "GitHub issue numbers to create workspaces for.",
        },
        baseBranch: {
          type: "string",
          description: "Base branch/ref to branch each workspace from.",
        },
        assign: {
          type: "boolean",
          description: "Assign each issue to you.",
        },
        startAgent: {
          type: "boolean",
          description: "Launch an agent in each workspace (default true).",
        },
        promptTemplate: {
          type: "string",
          description:
            "Prompt template for the launched agents. Supports {number}, {title}, {body}.",
        },
      },
      required: ["projectId", "issues"],
    },
  },
];

// ── Project & workspace types ──

interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
}

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
}

function formatWorkspace(ws: WorkspaceInfo): string {
  const label = ws.name ? `${ws.name} ` : "";
  const main = ws.isMain ? " [main]" : "";
  return `  - ${label}${ws.path} (${ws.branch})${main}`;
}

function formatProject(p: ProjectInfo): string {
  const lines = [
    `${p.id}: ${p.name}`,
    `  path: ${p.path}`,
    `  default branch: ${p.defaultBranch}`,
    `  workspaces (${p.workspaces.length}):`,
    ...p.workspaces.map(formatWorkspace),
  ];
  return lines.join("\n");
}

// ── Element context types and formatter ──

interface ReactComponent {
  name: string;
  source?: { fileName: string; lineNumber: number };
}

interface ElementContext {
  selector: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number };
  accessibility: Record<string, string>;
  reactComponents?: ReactComponent[];
  screenshot?: string;
}

function formatElementContext(paneId: string, ctx: ElementContext): string {
  const lines: string[] = [];

  lines.push(`<picked_element pane="${paneId}">`);

  lines.push("## Selector Path");
  lines.push(ctx.selector);
  lines.push("");

  lines.push("## HTML");
  lines.push(ctx.outerHTML);
  lines.push("");

  lines.push("## Computed Styles");
  lines.push(
    Object.entries(ctx.computedStyles)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; "),
  );
  lines.push("");

  const bb = ctx.boundingBox;
  lines.push("## Bounding Box");
  lines.push(`x: ${bb.x}, y: ${bb.y}, width: ${bb.width}, height: ${bb.height}`);
  lines.push("");

  lines.push("## Accessibility");
  const a11y = Object.entries(ctx.accessibility);
  lines.push(a11y.length > 0 ? a11y.map(([k, v]) => `${k}: ${v}`).join(", ") : "(none)");

  if (ctx.reactComponents && ctx.reactComponents.length > 0) {
    lines.push("");
    lines.push("## React Context");
    for (const comp of ctx.reactComponents) {
      const sourceStr = comp.source
        ? ` (at ${comp.source.fileName}:${comp.source.lineNumber})`
        : "";
      lines.push(`  in ${comp.name}${sourceStr}`);
    }
  }

  lines.push("</picked_element>");

  return lines.join("\n");
}

// ── Tool handlers ──

async function handleTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}> {
  try {
    switch (name) {
      case "list_webviews": {
        const webviews = (await httpGet("/webviews")) as WebviewInfo[];
        if (webviews.length === 0) {
          return text("No webviews are currently open in Manor.");
        }
        const listing = webviews
          .map((w) => `${w.paneId}: ${w.title} (${w.url})`)
          .join("\n");
        return text(listing);
      }

      case "screenshot_webview": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const result = (await httpPost(
          `/webview/${encodeURIComponent(id)}/screenshot`,
        )) as {
          image: string;
        };
        return {
          content: [
            {
              type: "image",
              data: result.image,
              mimeType: "image/png",
            },
          ],
        };
      }

      case "get_dom": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const result = (await httpPost(
          `/webview/${encodeURIComponent(id)}/dom`,
        )) as {
          html: string;
        };
        return text(result.html);
      }

      case "execute_js": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const result = (await httpPost(
          `/webview/${encodeURIComponent(id)}/execute-js`,
          {
            code: args.code,
          },
        )) as { result: unknown };
        return text(JSON.stringify(result.result, null, 2));
      }

      case "click_element": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const body: Record<string, unknown> = {};
        if (args.selector !== undefined) body.selector = args.selector;
        if (args.x !== undefined) body.x = args.x;
        if (args.y !== undefined) body.y = args.y;
        await httpPost(`/webview/${encodeURIComponent(id)}/click`, body);
        return text("Click performed successfully.");
      }

      case "type_text": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        await httpPost(`/webview/${encodeURIComponent(id)}/type`, {
          selector: args.selector,
          text: args.text,
        });
        return text("Text typed successfully.");
      }

      case "navigate": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        await httpPost(`/webview/${encodeURIComponent(id)}/navigate`, {
          url: args.url,
        });
        return text("Navigation complete.");
      }

      case "get_console_logs": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const entries = (await httpGet(
          `/webview/${encodeURIComponent(id)}/console-logs`,
        )) as Array<{ timestamp: string; level: string; message: string }>;
        if (entries.length === 0) {
          return text("No console logs recorded.");
        }
        const formatted = entries
          .map((e) => `[${e.timestamp}] ${e.level.toUpperCase()}: ${e.message}`)
          .join("\n");
        return text(formatted);
      }

      case "get_url": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const result = (await httpGet(
          `/webview/${encodeURIComponent(id)}/url`,
        )) as { url: string };
        return text(result.url);
      }

      case "pick_element": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const result = (await httpPost(
          `/webview/${encodeURIComponent(id)}/pick-element`,
          undefined,
          35_000,
        )) as ElementContext | { cancelled: true };
        if ("cancelled" in result && result.cancelled) {
          return text("Element picker was cancelled by the user.");
        }
        const ctx = result as ElementContext;
        const content: Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
        }> = [{ type: "text", text: formatElementContext(id, ctx) }];
        if (ctx.screenshot) {
          content.push({ type: "image", data: ctx.screenshot, mimeType: "image/png" });
        }
        return { content };
      }

      case "get_element_context": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const result = (await httpPost(
          `/webview/${encodeURIComponent(id)}/element-context`,
          { selector: args.selector as string },
        )) as ElementContext;
        const ctxContent: Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
        }> = [{ type: "text", text: formatElementContext(id, result) }];
        if (result.screenshot) {
          ctxContent.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
        }
        return { content: ctxContent };
      }

      case "list_projects": {
        const projects = (await httpGet("/projects")) as ProjectInfo[];
        if (projects.length === 0) {
          return text("No projects in Manor yet.");
        }
        const listing = projects
          .map(
            (p) =>
              `${p.id}: ${p.name} (${p.path}) — ${p.workspaces.length} workspace(s)`,
          )
          .join("\n");
        return text(listing);
      }

      case "get_project": {
        const project = (await httpGet(
          `/projects/${encodeURIComponent(args.projectId as string)}`,
        )) as ProjectInfo;
        return text(formatProject(project));
      }

      case "add_project": {
        const project = (await httpPost("/projects", {
          name: args.name,
          path: args.path,
        })) as ProjectInfo;
        return text(`Added project "${project.name}" (${project.id})`);
      }

      case "create_workspace": {
        const projectId = args.projectId as string;
        const body: Record<string, unknown> = { name: args.name };
        if (args.branch !== undefined) body.branch = args.branch;
        if (args.baseBranch !== undefined) body.baseBranch = args.baseBranch;
        if (args.useExistingBranch !== undefined)
          body.useExistingBranch = args.useExistingBranch;
        const project = (await httpPost(
          `/projects/${encodeURIComponent(projectId)}/workspaces`,
          body,
        )) as ProjectInfo;
        return text(
          `Created workspace "${args.name}" in project "${project.name}".\n\nWorkspaces now:\n${project.workspaces
            .map(formatWorkspace)
            .join("\n")}`,
        );
      }

      case "list_workspaces": {
        const workspaces = (await httpGet(
          `/projects/${encodeURIComponent(args.projectId as string)}/workspaces`,
        )) as WorkspaceInfo[];
        if (workspaces.length === 0) {
          return text("No workspaces in this project.");
        }
        return text(workspaces.map(formatWorkspace).join("\n"));
      }

      case "remove_workspace": {
        await httpDelete(
          `/projects/${encodeURIComponent(args.projectId as string)}/workspaces`,
          {
            worktreePath: args.worktreePath,
            ...(args.deleteBranch !== undefined
              ? { deleteBranch: args.deleteBranch }
              : {}),
          },
        );
        return text(`Removed workspace at ${args.worktreePath}.`);
      }

      case "list_issues": {
        const projectId = args.projectId as string;
        const params = new URLSearchParams();
        if (args.filter !== undefined) params.set("filter", String(args.filter));
        if (args.state !== undefined) params.set("state", String(args.state));
        if (args.limit !== undefined) params.set("limit", String(args.limit));
        const qs = params.toString();
        const issues = (await httpGet(
          `/projects/${encodeURIComponent(projectId)}/issues?${qs}`,
        )) as Array<{
          number: number;
          title: string;
          url: string;
          state: string;
          labels: Array<{ name: string }>;
          assignees: unknown;
        }>;
        if (issues.length === 0) {
          return text("No issues found.");
        }
        const listing = issues
          .map((issue) => {
            const labels =
              issue.labels && issue.labels.length > 0
                ? ` [${issue.labels.map((l) => l.name).join(", ")}]`
                : "";
            return `#${issue.number} ${issue.title}${labels}`;
          })
          .join("\n");
        return text(listing);
      }

      case "start_agent": {
        const body: Record<string, unknown> = {
          projectId: args.projectId,
          workspacePath: args.workspacePath,
        };
        if (args.prompt !== undefined) body.prompt = args.prompt;
        await httpPost("/agents", body);
        return text(`Launched agent in ${args.workspacePath}.`);
      }

      case "batch_create_workspaces": {
        const projectId = args.projectId as string;
        const body: Record<string, unknown> = { issues: args.issues };
        if (args.baseBranch !== undefined) body.baseBranch = args.baseBranch;
        if (args.assign !== undefined) body.assign = args.assign;
        if (args.startAgent !== undefined) body.startAgent = args.startAgent;
        if (args.promptTemplate !== undefined)
          body.promptTemplate = args.promptTemplate;
        const result = (await httpPost(
          `/projects/${encodeURIComponent(projectId)}/workspaces/batch`,
          body,
        )) as {
          results: Array<{
            number: number;
            title: string;
            workspacePath: string;
            started: boolean;
            error?: string;
          }>;
        };
        const listing = result.results
          .map((r) => {
            const status = r.error
              ? `(failed: ${r.error})`
              : r.started
                ? "(agent started)"
                : "(workspace created)";
            return `#${r.number} → ${r.workspacePath} ${status}`;
          })
          .join("\n");
        return text(listing);
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message =
      err instanceof TypeError && (err as NodeJS.ErrnoException).cause
        ? "Cannot connect to Manor — is it running?"
        : String(err instanceof Error ? err.message : err);
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

// ── Server setup ──

const server = new Server(
  { name: "manor", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  return handleTool(name, args as Record<string, unknown>);
});

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-manor] Server running on stdio");
}

main().catch((err) => {
  console.error("[mcp-manor] Fatal:", err);
  process.exit(1);
});
