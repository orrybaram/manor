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

// ── Port discovery ──

const PORT_FILE = path.join(
  process.env.HOME || "/tmp",
  ".manor",
  "webview-server-port",
);

function readPort(): number {
  if (!fs.existsSync(PORT_FILE)) {
    console.error(
      `[mcp-webview] Port file not found at ${PORT_FILE} — is Manor running?`,
    );
    process.exit(1);
  }
  const port = parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10);
  if (isNaN(port)) {
    console.error(`[mcp-webview] Invalid port in ${PORT_FILE}`);
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
];

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
    const [closest, ...parents] = ctx.reactComponents;
    const sourceStr = closest.source
      ? ` at ${closest.source.fileName}:${closest.source.lineNumber}`
      : "";
    lines.push(`Component: ${closest.name}${sourceStr}`);
    if (parents.length > 0) {
      const chain = [...parents].reverse().map((c) => c.name);
      chain.push(closest.name);
      lines.push(`Parent chain: ${chain.join(" > ")}`);
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
        return text(formatElementContext(id, result as ElementContext));
      }

      case "get_element_context": {
        const id = await resolvePaneId(args.paneId as string | undefined);
        const result = (await httpPost(
          `/webview/${encodeURIComponent(id)}/element-context`,
          { selector: args.selector as string },
        )) as ElementContext;
        return text(formatElementContext(id, result));
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
  { name: "manor-webview", version: "0.1.0" },
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
  console.error("[mcp-webview] Server running on stdio");
}

main().catch((err) => {
  console.error("[mcp-webview] Fatal:", err);
  process.exit(1);
});
