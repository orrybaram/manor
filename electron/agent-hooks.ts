/**
 * Agent hook server — receives lifecycle events from agent CLIs
 * (Claude Code, Codex, etc.) via their native hook systems.
 *
 * Architecture:
 * 1. On startup, each AgentConnector registers hooks in its own config
 * 2. Starts an HTTP server on a random port
 * 3. PTY sessions get MANOR_HOOK_PORT env var so hooks can call back
 * 4. Hook script (curl) → HTTP server → IPC to renderer
 *
 * Remote hosts (ADR-178 §2) never reach this server: their daemon journals
 * hooks itself, and the host's hook feed hands each one to
 * `ingestHookPayload`, the same path the HTTP handler takes.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

import { hookPortFile } from "./paths";
import {
  type AgentHookEvent,
  hookRequestParams,
  parseAgentHookEvent,
} from "./agent-hook-events";
import type { HookPayload } from "./terminal-host/types";
import { LOCAL_HOST_ID } from "./backend/types";

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

function fromHost(ctx: { hostId: string }): string {
  return ctx.hostId === LOCAL_HOST_ID ? "" : ` from ${ctx.hostId}`;
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

  /**
   * Feed one hook into the relay — the single entry point for hooks from
   * every host (ADR-178 §2). The local HTTP server calls it for each request;
   * a remote host's hook feed calls it for each journaled entry, replayed or
   * live. `payload` is the hook request's query parameters.
   *
   * Returns what became of it: `relayed` (or queued until `setRelay`),
   * `dropped` (well-formed but not relayed), or `rejected` (malformed).
   */
  ingestHookPayload(
    payload: URLSearchParams | HookPayload,
    ctx: { hostId: string },
  ): "relayed" | "dropped" | "rejected" {
    const params =
      payload instanceof URLSearchParams ? payload : new URLSearchParams(payload);
    const result = parseAgentHookEvent(params);
    if (!result.ok) {
      if (result.action === "reject") {
        console.warn(`[agent-hooks] rejecting hook${fromHost(ctx)}: ${result.reason}`);
        return "rejected";
      }
      console.debug(`[agent-hooks] dropping hook${fromHost(ctx)}: ${result.reason}`);
      return "dropped";
    }
    const event = result.event;
    console.debug(
      `[agent-status] hook ${ctx.hostId === LOCAL_HOST_ID ? "HTTP" : `from ${ctx.hostId}`}: paneId=${event.paneId} event=${event.type} kind=${event.agentKind} sessionId=${event.sessionId} → status=${event.status}`,
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
    return "relayed";
  }

  /** Start the HTTP server on a random port */
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const params = hookRequestParams(req.url);
      if (!params) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (this.ingestHookPayload(params, { hostId: LOCAL_HOST_ID }) === "rejected") {
        res.writeHead(400);
        res.end();
        return;
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

  /**
   * Stop listening, and remove the port file only if it still names this
   * server — another Manor instance may have written its own port since.
   */
  stop(): void {
    this.server?.close();
    this.server = null;
    try {
      if (this.port && fs.readFileSync(HOOK_PORT_FILE, "utf-8").trim() === String(this.port)) {
        fs.unlinkSync(HOOK_PORT_FILE);
      }
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
