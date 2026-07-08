/**
 * MCP tools for inspecting and controlling webview panes.
 */

import type { Http, ToolDef, ToolModule } from "./types";
import { text } from "./types";

// ── Pane resolution ──

export interface WebviewInfo {
  paneId: string;
  url: string;
  title: string;
}

export async function resolvePaneId(
  http: Http,
  paneId: string | undefined,
): Promise<string> {
  if (paneId) return paneId;

  const webviews = (await http.get("/webviews")) as WebviewInfo[];
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

// ── Element context types and formatter ──

export interface ReactComponent {
  name: string;
  source?: { fileName: string; lineNumber: number };
}

export interface ElementContext {
  selector: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number };
  accessibility: Record<string, string>;
  reactComponents?: ReactComponent[];
  screenshot?: string;
}

export function formatElementContext(
  paneId: string,
  ctx: ElementContext,
): string {
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

// ── Tool definitions ──

const tools: ToolDef[] = [
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

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  async list_webviews(_args, http) {
    const webviews = (await http.get("/webviews")) as WebviewInfo[];
    if (webviews.length === 0) {
      return text("No webviews are currently open in Manor.");
    }
    const listing = webviews
      .map((w) => `${w.paneId}: ${w.title} (${w.url})`)
      .join("\n");
    return text(listing);
  },

  async screenshot_webview(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const result = (await http.post(
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
  },

  async get_dom(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const result = (await http.post(`/webview/${encodeURIComponent(id)}/dom`)) as {
      html: string;
    };
    return text(result.html);
  },

  async execute_js(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const result = (await http.post(
      `/webview/${encodeURIComponent(id)}/execute-js`,
      {
        code: args.code,
      },
    )) as { result: unknown };
    return text(JSON.stringify(result.result, null, 2));
  },

  async click_element(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const body: Record<string, unknown> = {};
    if (args.selector !== undefined) body.selector = args.selector;
    if (args.x !== undefined) body.x = args.x;
    if (args.y !== undefined) body.y = args.y;
    await http.post(`/webview/${encodeURIComponent(id)}/click`, body);
    return text("Click performed successfully.");
  },

  async type_text(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    await http.post(`/webview/${encodeURIComponent(id)}/type`, {
      selector: args.selector,
      text: args.text,
    });
    return text("Text typed successfully.");
  },

  async navigate(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    await http.post(`/webview/${encodeURIComponent(id)}/navigate`, {
      url: args.url,
    });
    return text("Navigation complete.");
  },

  async get_console_logs(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const entries = (await http.get(
      `/webview/${encodeURIComponent(id)}/console-logs`,
    )) as Array<{ timestamp: string; level: string; message: string }>;
    if (entries.length === 0) {
      return text("No console logs recorded.");
    }
    const formatted = entries
      .map((e) => `[${e.timestamp}] ${e.level.toUpperCase()}: ${e.message}`)
      .join("\n");
    return text(formatted);
  },

  async get_url(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const result = (await http.get(`/webview/${encodeURIComponent(id)}/url`)) as {
      url: string;
    };
    return text(result.url);
  },

  async pick_element(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const result = (await http.post(
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
  },

  async get_element_context(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const result = (await http.post(
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
  },
};

export const webviewModule: ToolModule = { tools, handlers };
