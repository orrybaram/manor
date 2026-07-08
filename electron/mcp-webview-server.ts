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
import { webviewServerPortFile } from "./paths";
import type { Http } from "./mcp/types";
import { HttpError, text } from "./mcp/types";
import { webviewModule } from "./mcp/tools-webview";
import { projectsModule } from "./mcp/tools-projects";
import { agentsModule } from "./mcp/tools-agents";
import { panesModule } from "./mcp/tools-panes";

// ── Port discovery ──

const PORT_FILE = webviewServerPortFile();

// Candidate ports to reach Manor's webview server, in priority order:
//   1. MANOR_WEBVIEW_PORT env — set by the host Manor instance (correct target
//      in multi-instance setups), but goes stale if that instance restarts.
//   2. The ~/.manor/webview-server-port file — always rewritten by the running
//      instance, so it self-heals after a restart.
// Resolved per request (not cached at startup) so restarts don't wedge us.
function candidatePorts(): number[] {
  const ports: number[] = [];
  const envPort = parseInt(process.env.MANOR_WEBVIEW_PORT ?? "", 10);
  if (!isNaN(envPort) && envPort > 0) ports.push(envPort);
  if (fs.existsSync(PORT_FILE)) {
    const filePort = parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10);
    if (!isNaN(filePort) && filePort > 0 && !ports.includes(filePort)) {
      ports.push(filePort);
    }
  }
  if (ports.length === 0) {
    throw new Error(
      `No Manor webview port found (env MANOR_WEBVIEW_PORT or ${PORT_FILE}) — is Manor running?`,
    );
  }
  return ports;
}

// Try each candidate port until one answers. Connection-level failures fall
// through to the next candidate; an HTTP error from a live server is surfaced
// as-is (don't mask a real error by retrying a different instance).
async function request(urlPath: string, init?: RequestInit): Promise<unknown> {
  let lastErr: unknown;
  for (const port of candidatePorts()) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, init);
      if (!res.ok) {
        const rawBody = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          // not JSON; body stays null
        }
        throw new HttpError(res.status, parsed, rawBody);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const isConnError =
        err instanceof TypeError && (err as NodeJS.ErrnoException).cause;
      if (!isConnError) throw err;
    }
  }
  throw lastErr;
}

// ── HTTP helpers ──

async function httpGet(urlPath: string): Promise<unknown> {
  return request(urlPath);
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
  return request(urlPath, init);
}

async function httpDelete(
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const init: RequestInit = {
    method: "DELETE",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  return request(urlPath, init);
}

const http: Http = {
  get: httpGet,
  post: httpPost,
  del: httpDelete,
};

// ── Tool modules ──

const modules = [webviewModule, projectsModule, agentsModule, panesModule];
const TOOLS = modules.flatMap((m) => m.tools);
const handlers = Object.assign({}, ...modules.map((m) => m.handlers));

// ── Tool dispatch ──

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
    const handler = handlers[name];
    if (!handler) {
      return text(`Unknown tool: ${name}`);
    }
    return await handler(args, http);
  } catch (err) {
    const message =
      err instanceof TypeError && (err as NodeJS.ErrnoException).cause
        ? "Cannot connect to Manor — is it running?"
        : String(err instanceof Error ? err.message : err);
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
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
