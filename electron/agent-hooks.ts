/**
 * Agent hook server — receives lifecycle events from agent CLIs
 * (Claude Code, Codex, etc.) via their native hook systems.
 *
 * Architecture:
 * 1. On startup, each AgentConnector registers hooks in its own config
 * 2. Starts an HTTP server on a random port
 * 3. PTY sessions get MANOR_HOOK_PORT env var so hooks can call back
 * 4. Hook script (curl) → HTTP server → IPC to renderer
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

// Map hook event names to our status
import type { AgentStatus, AgentKind } from "./terminal-host/types";
import { getAllConnectors } from "./agent-connectors";
import { hookScriptPath, hookScriptJsPath, hookPortFile } from "./paths";

type PaneStatus = AgentStatus;

type RelayArgs = [
  paneId: string,
  status: AgentStatus,
  kind: AgentKind,
  sessionId: string | null,
  eventType: string,
  toolUseId: string | null,
];

export function mapEventToStatus(eventType: string): PaneStatus | null {
  switch (eventType) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "SubagentStop":
      return "thinking";
    case "PreToolUse":
    case "SubagentStart":
      return "working";
    case "PermissionRequest":
    case "Notification":
      return "requires_input";
    case "Stop":
      return "responded";
    case "StopFailure":
      return "error";
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

export class AgentHookServer {
  private server: http.Server | null = null;
  private port = 0;
  private relayFn: ((...args: RelayArgs) => void) | null = null;
  private pending: RelayArgs[] = [];
  static readonly MAX_PENDING = 1000;

  get hookPort(): number {
    return this.port;
  }

  /** Set the relay function. Any events buffered before this call are replayed in order. */
  setRelay(relay: (...args: RelayArgs) => void): void {
    this.relayFn = relay;
    const queued = this.pending;
    this.pending = [];
    for (const args of queued) {
      try {
        relay(...args);
      } catch (err) {
        console.error("[agent-hooks] error replaying queued event:", err);
      }
    }
  }

  /** Start the HTTP server on a random port */
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1`);

      if (url.pathname !== "/hook/event") {
        res.writeHead(404);
        res.end();
        return;
      }

      const paneId = url.searchParams.get("paneId");
      const eventType = url.searchParams.get("eventType");
      const sessionId = url.searchParams.get("sessionId");
      const kind = (url.searchParams.get("kind") ?? "claude") as AgentKind;
      const toolUseId = url.searchParams.get("toolUseId");

      if (!paneId || !eventType) {
        res.writeHead(400);
        res.end();
        return;
      }

      const status = mapEventToStatus(eventType);
      console.debug(
        `[agent-status] hook HTTP: paneId=${paneId} event=${eventType} kind=${kind} sessionId=${sessionId} toolUseId=${toolUseId} → status=${status ?? "unmapped"}`,
      );
      if (status) {
        if (this.relayFn) {
          this.relayFn(paneId, status, kind, sessionId, eventType, toolUseId);
        } else if (this.pending.length < AgentHookServer.MAX_PENDING) {
          this.pending.push([paneId, status, kind, sessionId, eventType, toolUseId]);
        } else {
          console.warn(
            `[agent-hooks] dropping hook event (queue full): paneId=${paneId} event=${eventType}`,
          );
        }
      }

      res.writeHead(200);
      res.end("ok");
    });

    return new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          fs.mkdirSync(path.dirname(HOOK_PORT_FILE), { recursive: true });
          fs.writeFileSync(HOOK_PORT_FILE, String(this.port));
        }
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    try {
      fs.unlinkSync(HOOK_PORT_FILE);
    } catch {
      // File may not exist; ignore
    }
  }
}

// ── Hook Script & Registration ──

export const HOOK_SCRIPT_PATH = hookScriptPath();
export const HOOK_SCRIPT_JS_PATH = hookScriptJsPath();

const HOOK_PORT_FILE = hookPortFile();

/**
 * Resolve the path to the bundled agent-hook.js source. In packaged
 * builds the asar archive isn't readable by plain Node when invoked
 * via `node /path/to/agent-hook.js`, so we point at the unpacked copy
 * extracted by electron-builder's asarUnpack. Mirrors the MCP-server
 * pattern below in registerAllAgents().
 */
function bundledAgentHookJsPath(): string {
  return path
    .join(__dirname, "agent-hook.js")
    .replace("app.asar", "app.asar.unpacked");
}

/**
 * Bash wrapper that exec's the Node script with stdin and any args
 * forwarded. Two reasons we keep a wrapper rather than registering
 * `node /path/...` directly with the agent CLIs:
 *   1. Backward compat: existing user configs already point at .sh.
 *   2. Lets us evolve the JS path/argv without rewriting agent configs.
 */
const HOOK_SCRIPT = `#!/bin/bash
# Manor agent hook — thin shim that delegates to the Node implementation.
# The real logic lives in notify.js next to this file.
exec node "$(dirname "$0")/notify.js" "$@"
`;

/**
 * Ensure both hook scripts exist on disk: the bash wrapper agents
 * register against, and the Node script that does the real work.
 */
export function ensureHookScript(): void {
  const dir = path.dirname(HOOK_SCRIPT_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });

  // Copy the bundled JS implementation alongside the wrapper. In
  // unit tests this module runs directly from source (vitest loads
  // agent-hooks.ts) and the bundled file doesn't exist; fall back to
  // the source under electron/scripts/.
  const jsSrc = bundledAgentHookJsPath();
  let jsContent: string;
  try {
    jsContent = fs.readFileSync(jsSrc, "utf-8");
  } catch {
    const devSrc = path.join(__dirname, "scripts", "agent-hook.js");
    jsContent = fs.readFileSync(devSrc, "utf-8");
  }
  fs.writeFileSync(HOOK_SCRIPT_JS_PATH, jsContent, { mode: 0o755 });
}

/** Register hooks and MCP for all known agent connectors */
export function registerAllAgents(): void {
  // In packaged builds, the asar archive is not readable by plain Node.js,
  // so we point to the unpacked copy extracted by electron-builder's asarUnpack.
  const mcpServerScriptPath = path
    .join(__dirname, "mcp-webview-server.js")
    .replace("app.asar", "app.asar.unpacked");

  for (const connector of getAllConnectors()) {
    connector.registerHooks(HOOK_SCRIPT_PATH);
    connector.registerMcp(mcpServerScriptPath);
  }
}
