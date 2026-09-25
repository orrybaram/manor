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

import { hookPortFile } from "./paths";
import {
  type AgentHookEvent,
  parseAgentHookEvent,
} from "./agent-hook-events";

/**
 * Atomically write the port number to the hook port file.
 * Uses tmp + rename pattern to ensure the file is never in a half-written state,
 * preventing hook scripts from reading garbage if a write is interrupted.
 */
function writePortFileAtomic(port: number): void {
  fs.mkdirSync(path.dirname(HOOK_PORT_FILE), { recursive: true });
  const tmp = `${HOOK_PORT_FILE}.tmp`;
  fs.writeFileSync(tmp, String(port));
  fs.renameSync(tmp, HOOK_PORT_FILE);
}

export type RelayFn = (event: AgentHookEvent) => void;

export class AgentHookServer {
  private server: http.Server | null = null;
  private port = 0;
  private relayFn: RelayFn | null = null;
  private pending: AgentHookEvent[] = [];
  static readonly MAX_PENDING = 1000;

  get hookPort(): number {
    return this.port;
  }

  /** Set the relay function. Any events buffered before this call are replayed in order. */
  setRelay(relay: RelayFn): void {
    this.relayFn = relay;
    const queued = this.pending;
    this.pending = [];
    for (const event of queued) {
      try {
        relay(event);
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

      const result = parseAgentHookEvent(url.searchParams);

      if (!result.ok) {
        if (result.action === "reject") {
          console.warn(`[agent-hooks] rejecting hook: ${result.reason}`);
          res.writeHead(400);
          res.end();
        } else {
          console.debug(`[agent-hooks] dropping hook: ${result.reason}`);
          res.writeHead(200);
          res.end("ok");
        }
        return;
      }

      const event = result.event;
      console.debug(
        `[agent-status] hook HTTP: paneId=${event.paneId} event=${event.type} kind=${event.agentKind} sessionId=${event.sessionId} → status=${event.status}`,
      );

      if (this.relayFn) {
        this.relayFn(event);
      } else if (this.pending.length < AgentHookServer.MAX_PENDING) {
        this.pending.push(event);
      } else {
        console.warn(
          `[agent-hooks] dropping hook event (queue full): paneId=${event.paneId} event=${event.type}`,
        );
      }

      res.writeHead(200);
      res.end("ok");
    });

    return new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          writePortFileAtomic(this.port);
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
//
// The hook scripts and connector registration live in the Electron-free
// bootstrap module so the terminal-host daemon can run them on its own host.

export {
  ensureHookScript,
  registerAllAgents,
} from "./terminal-host/bootstrap-host";

const HOOK_PORT_FILE = hookPortFile();
