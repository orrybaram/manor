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
import { text } from "./mcp/types";
import { createHttp, isConnectionError } from "./mcp/http-client";
import { modules } from "./mcp/modules";

const http = createHttp();

// ── Tool modules ──

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
    const message = isConnectionError(err)
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
