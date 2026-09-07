/**
 * The `manor` CLI — runs as a standalone Node.js process (NOT inside
 * Electron). Generated from the same `ToolModule` definitions the MCP entry
 * (`mcp-webview-server.ts`) registers (ADR-170); see `mcp/cli.ts` for the
 * command table and dispatch logic.
 *
 * Discovery: reads port from ~/.manor/webview-server-port
 */

import { createHttp } from "./mcp/http-client";
import { runCli } from "./mcp/cli";

runCli(process.argv.slice(2), createHttp(), process)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
