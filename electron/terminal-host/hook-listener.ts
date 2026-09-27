/**
 * Hook listener — the remote daemon's own agent-hook endpoint (ADR-178 §2).
 *
 * On a remote host there is no `AgentHookServer` (that lives in Electron
 * main, on the laptop), so the daemon listens instead. It accepts exactly
 * the requests `AgentHookServer` accepts — both go through
 * `classifyHookRequest` — journals each relayable one, and hands the entry to
 * `onEntry` for broadcast to stream sockets.
 *
 * Loopback only, and — unlike `AgentHookServer` — authenticated: a remote box
 * may be shared, and another user there must not be able to flood the
 * journal and evict real entries. Each listener mints a random token and
 * publishes it with its port in the remote namespace's port file
 * (`<port>\n<token>`, mode 0600, readable only by this user); the hook
 * script sends it back in `HOOK_TOKEN_HEADER`, and requests without it are
 * refused with 403.
 *
 * The port file's path is set as `MANOR_HOOK_PORT_FILE` (and the port as
 * `MANOR_HOOK_PORT`) in the daemon's own env, so PTYs spawned from here on
 * inherit them and the hook script finds this listener rather than a Manor
 * desktop's on the same box (whose port file, ~/.manor/hook-port, this never
 * touches).
 *
 * Electron-free: the daemon bundle imports this.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { classifyHookRequest } from "../agent-hook-events";
import type { HookJournal } from "./hook-journal";
import type { HookJournalEntry } from "./types";

/**
 * The request header carrying the listener's token. Keep in sync with
 * electron/scripts/agent-hook.js.
 */
export const HOOK_TOKEN_HEADER = "x-manor-hook-token";

export interface HookListenerOptions {
  journal: HookJournal;
  /** Called with every journaled entry, after it is on disk. */
  onEntry: (entry: HookJournalEntry) => void;
  /** Where to publish the port; null to skip. */
  portFile: string | null;
  /** Env to set `MANOR_HOOK_PORT{,_FILE}` in; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

function writePortFileAtomic(file: string, port: number, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${port}\n${token}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
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
        const [port] = fs.readFileSync(portFile, "utf-8").split("\n");
        if (port?.trim() === String(this.listenPort)) {
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
    const token = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => {
      if (!tokenMatches(req.headers[HOOK_TOKEN_HEADER], token)) {
        res.writeHead(403);
        res.end();
        return;
      }
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
        const env = this.opts.env ?? process.env;
        env.MANOR_HOOK_PORT = String(port);
        if (this.opts.portFile) {
          env.MANOR_HOOK_PORT_FILE = this.opts.portFile;
          try {
            writePortFileAtomic(this.opts.portFile, port, token);
          } catch (err) {
            log(`hook listener: could not write port file: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        resolve(port);
      });
    });
  }
}
