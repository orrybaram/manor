/**
 * Hook listener — the remote daemon's own agent-hook endpoint (ADR-178 §2).
 *
 * On a remote host there is no `AgentHookServer` (that lives in Electron
 * main, on the laptop), so the daemon listens instead. It accepts exactly
 * the requests `AgentHookServer` accepts — both go through
 * `classifyHookRequest` — journals each relayable one, and hands the entry to
 * `onEntry` for broadcast to stream sockets.
 *
 * Loopback only, and like `AgentHookServer` unauthenticated: the hook script
 * sends no secret, and anything able to reach 127.0.0.1 on the box can
 * already talk to the agent CLIs it would be impersonating.
 *
 * The port is written to the box's `hook-port` file (which the hook script
 * prefers over `MANOR_HOOK_PORT`) and set as `MANOR_HOOK_PORT` in the
 * daemon's own env, so PTYs spawned from here on inherit it.
 *
 * Electron-free: the daemon bundle imports this.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { classifyHookRequest } from "../agent-hook-events";
import type { HookJournal } from "./hook-journal";
import type { HookJournalEntry } from "./types";

export interface HookListenerOptions {
  journal: HookJournal;
  /** Called with every journaled entry, after it is on disk. */
  onEntry: (entry: HookJournalEntry) => void;
  /** Where to publish the port; null to skip. */
  portFile: string | null;
  /** Env to set `MANOR_HOOK_PORT` in; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

function writePortFileAtomic(file: string, port: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, String(port));
  fs.renameSync(tmp, file);
}

export class HookListener {
  private server: http.Server | null = null;
  private listenPort = 0;
  private starting: Promise<number> | null = null;

  constructor(private readonly opts: HookListenerOptions) {}

  /** The bound port; 0 until `start()` resolves. */
  get port(): number {
    return this.listenPort;
  }

  /** Start listening (idempotent). Resolves the port. */
  start(): Promise<number> {
    this.starting ??= this.listen().catch((err: unknown) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  /** Stop listening, and remove the port file if it still names this listener. */
  stop(): void {
    const { portFile } = this.opts;
    if (portFile && this.listenPort) {
      try {
        if (fs.readFileSync(portFile, "utf-8").trim() === String(this.listenPort)) {
          fs.unlinkSync(portFile);
        }
      } catch {
        // Already gone, or unreadable — nothing of ours to remove.
      }
    }
    this.server?.close();
    this.server = null;
    this.starting = null;
    this.listenPort = 0;
  }

  private listen(): Promise<number> {
    const log = this.opts.log ?? (() => {});
    const server = http.createServer((req, res) => {
      const verdict = classifyHookRequest(req.url);
      if (verdict.status !== 200) {
        if (verdict.status === 400) log(`hook listener: rejecting hook: ${verdict.reason}`);
        res.writeHead(verdict.status);
        res.end();
        return;
      }
      if (verdict.payload !== undefined) {
        const entry = this.opts.journal.append(verdict.payload);
        try {
          this.opts.onEntry(entry);
        } catch (err) {
          log(`hook listener: onEntry threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      res.writeHead(200);
      res.end("ok");
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (err) => log(`hook listener error: ${err.message}`));
        const addr = server.address();
        const port = addr && typeof addr === "object" ? addr.port : 0;
        this.server = server;
        this.listenPort = port;
        (this.opts.env ?? process.env).MANOR_HOOK_PORT = String(port);
        if (this.opts.portFile) {
          try {
            writePortFileAtomic(this.opts.portFile, port);
          } catch (err) {
            log(`hook listener: could not write port file: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        resolve(port);
      });
    });
  }
}
