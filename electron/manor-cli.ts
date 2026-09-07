/**
 * The `manor` CLI — runs as a standalone Node.js process (NOT inside
 * Electron). Generated from the same `ToolModule` definitions the MCP entry
 * (`mcp-webview-server.ts`) registers (ADR-170); see `mcp/cli.ts` for the
 * command table and dispatch logic.
 *
 * Discovery: reads port from ~/.manor/webview-server-port
 */

import * as fs from "node:fs";

import { createHttp } from "./mcp/http-client";
import { runCli } from "./mcp/cli";

const io = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: { read: () => fs.readFileSync(0, "utf-8") },
};

runCli(process.argv.slice(2), createHttp(), io)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
