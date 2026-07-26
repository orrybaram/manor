/**
 * MCP tools for inspecting and controlling webview panes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Http, ToolDef, ToolModule } from "./types";
import { text } from "./types";

/**
 * Persist a base64-encoded PNG to disk. Relative paths resolve against the MCP
 * process cwd (the caller's workspace); a `.png` extension is appended when the
 * given path has none, and parent directories are created as needed. Returns
 * the absolute path written.
 */
function saveScreenshotToDisk(base64Png: string, savePath: string): string {
  let resolved = path.resolve(savePath);
  if (path.extname(resolved) === "") {
    resolved += ".png";
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, Buffer.from(base64Png, "base64"));
  return resolved;
}

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
    description:
      "Take a screenshot of a webview pane. Returns a PNG image, or saves it to disk when 'path' is given.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
        path: {
          type: "string",
          description:
            "Optional file path to save the PNG to disk instead of returning the image. Relative paths resolve against the current working directory; a '.png' extension is added if missing.",
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
  {
    name: "start_recording",
    description:
      "Start recording a webview pane to a .webm file on disk. Returns immediately with a " +
      "recordingId; call stop_recording with that id when you're done — every start_recording " +
      "must be paired with a stop_recording. Recording is not open-ended: it auto-stops after " +
      "maxDurationSec (default 120s). Note that .webm does not open in QuickTime, but plays fine " +
      "in Chrome, VS Code, and IINA — keep that in mind if you're handing the path to a human.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paneId: {
          type: "string",
          description: "Pane ID. Omit if only one webview is open.",
        },
        path: {
          type: "string",
          description:
            "Optional file path to write the .webm to. Relative paths resolve against the current working directory.",
        },
        maxDurationSec: {
          type: "number",
          description: "Auto-stop after this many seconds. Default 120.",
        },
        keyframeIntervalSec: {
          type: "number",
          description: "Interval in seconds between sampled keyframe images. Default 2.",
        },
      },
    },
  },
  {
    name: "stop_recording",
    description:
      "Stop a recording started with start_recording. Returns the file path on disk plus a set " +
      "of sampled keyframe images from the recording — the video itself is not returned inline, " +
      "so do not expect its contents in this response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recordingId: {
          type: "string",
          description: "Recording ID returned by start_recording. Omit if only one recording is active for the pane.",
        },
      },
    },
  },
  {
    name: "list_recordings",
    description: "List currently active recordings and how long each has been running.",
    inputSchema: {
      type: "object" as const,
      properties: {},
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

    const savePath = args.path as string | undefined;
    if (savePath) {
      const written = saveScreenshotToDisk(result.image, savePath);
      return text(`Screenshot saved to ${written}`);
    }

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

  async start_recording(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const body: Record<string, unknown> = {};
    if (args.path !== undefined) body.path = args.path;
    if (args.maxDurationSec !== undefined) body.maxDurationSec = args.maxDurationSec;
    if (args.keyframeIntervalSec !== undefined)
      body.keyframeIntervalSec = args.keyframeIntervalSec;

    const result = (await http.post(
      `/webview/${encodeURIComponent(id)}/record/start`,
      body,
    )) as { recordingId: string; path: string; warning?: string };

    let message = `Recording started: ${result.recordingId}\nWriting to ${result.path}`;
    if (result.warning) {
      message += `\nWarning: ${result.warning}`;
    }
    return text(message);
  },

  async stop_recording(args, http) {
    const id = await resolvePaneId(http, args.paneId as string | undefined);
    const body: Record<string, unknown> = {};
    if (args.recordingId !== undefined) body.recordingId = args.recordingId;

    const result = (await http.post(
      `/webview/${encodeURIComponent(id)}/record/stop`,
      body,
    )) as {
      path: string;
      durationMs: number;
      bytes: number;
      keyframes: string[];
      alreadyStopped?: boolean;
    };

    let message = `Recording stopped: ${result.path}\nDuration: ${result.durationMs}ms, size: ${result.bytes} bytes`;
    if (result.alreadyStopped) {
      message +=
        "\nNote: this recording had already finished (likely hit its maxDurationSec limit) before this call — this call did not stop it, it just fetched the cached result.";
    }

    const content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }> = [{ type: "text", text: message }];
    for (const keyframe of result.keyframes) {
      content.push({ type: "image", data: keyframe, mimeType: "image/png" });
    }
    return { content };
  },

  async list_recordings(_args, http) {
    const recordings = (await http.get("/recordings")) as Array<{
      recordingId: string;
      paneId: string;
      path: string;
      elapsedMs: number;
    }>;
    if (recordings.length === 0) {
      return text("No active recordings.");
    }
    const formatted = recordings
      .map(
        (r) =>
          `${r.recordingId} (pane ${r.paneId}): ${r.path} — ${r.elapsedMs}ms elapsed`,
      )
      .join("\n");
    return text(formatted);
  },
};

export const webviewModule: ToolModule = { tools, handlers };
