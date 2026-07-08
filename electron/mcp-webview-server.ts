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
import { text } from "./mcp/types";
import { webviewModule } from "./mcp/tools-webview";
import { projectsModule } from "./mcp/tools-projects";
import { agentsModule } from "./mcp/tools-agents";

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

const http: Http = {
  get: httpGet,
  post: httpPost,
  del: httpDelete,
};

// ── Tool modules ──

const modules = [webviewModule, projectsModule, agentsModule];
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
