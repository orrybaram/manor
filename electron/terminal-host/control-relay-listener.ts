/**
 * Control relay listener — the remote daemon's endpoint for the `manor` CLI
 * (ADR-189 §1).
 *
 * The CLI talks HTTP to Manor desktop's webview server, which on a remote
 * host is on another machine, with no route back to it (ADR-178 dropped
 * reverse forwards). So the daemon listens instead and relays each request to
 * main over the stream connection it already has: the request goes out as a
 * `controlRequest` stream event, main runs it through its own control routes
 * and answers with a `controlResponse`, and the listener replies to the CLI
 * with that status and body.
 *
 * Loopback only, and authenticated the same way as `HookListener`: a remote
 * box may be shared, and another user there must not be able to change this
 * user's Manor. Each listener mints a random token and publishes it with its
 * port in the remote namespace's port file (`<port>\n<token>`, mode 0600,
 * readable only by this user); the CLI sends it back in
 * `CONTROL_TOKEN_HEADER`, and requests without it are refused with 403.
 *
 * The port file's path is set as `MANOR_CONTROL_PORT_FILE` in the daemon's own
 * env, so PTYs spawned from here on inherit it and the CLI relays through this
 * daemon rather than talking to a Manor desktop on the same box, which does
 * not own these terminals.
 *
 * `ControlRelayStreams` is the daemon side of the relay: which stream socket
 * requests go to, and the requests waiting on an answer.
 *
 * Electron-free: the daemon bundle imports this.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";

import { errorMessage } from "../lib/errors";
import { writeFileAtomic } from "../lib/fs-atomic";
import type { StreamEvent } from "./types";

/**
 * The request header carrying the listener's token. Keep in sync with
 * electron/mcp/http-client.ts.
 */
export const CONTROL_TOKEN_HEADER = "x-manor-control-token";

/** Request bodies larger than this are refused with 413. */
export const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

/** How long a relayed request waits for main's answer before a 504. */
export const CONTROL_RELAY_TIMEOUT_MS = 30_000;

/** One CLI request, as relayed to main. `path` includes the query string. */
export interface RelayedControlRequest {
  method: string;
  path: string;
  /** The parsed JSON body; undefined when the request had none. */
  body: unknown;
}

/** What the CLI gets back: an HTTP status and a JSON body. */
export interface ControlRelayResult {
  status: number;
  body: unknown;
}

/**
 * Hand a request to main. Null when there is no relay stream to send it on
 * (the laptop is disconnected, or runs an app too old to relay); the promise
 * never rejects — timeouts and dropped streams resolve with a 504 / 503.
 */
export type ControlRelay = (
  req: RelayedControlRequest,
) => Promise<ControlRelayResult> | null;

export interface ControlRelayListenerOptions {
  relay: ControlRelay;
  /** Where to publish the port; null to skip. */
  portFile: string | null;
  /** Env to set `MANOR_CONTROL_PORT_FILE` in; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

const NOT_CONNECTED: ControlRelayResult = {
  status: 503,
  body: { error: "Manor desktop is not connected to this host" },
};

const TIMED_OUT: ControlRelayResult = {
  status: 504,
  body: { error: "Manor desktop did not answer in time" },
};

function writePortFileAtomic(file: string, port: number, token: string): void {
  writeFileAtomic(file, `${port}\n${token}\n`, { mode: 0o600, dirMode: 0o700 });
}

function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  // `status` came over the wire from main; an invalid one would make
  // writeHead throw rather than answer the CLI at all.
  const valid = Number.isInteger(status) && status >= 200 && status <= 599;
  const payload = valid
    ? body
    : { error: `Manor desktop answered with an invalid status: ${String(status)}` };
  res.writeHead(valid ? status : 502, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload ?? null));
}

type BodyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Read and parse a request body, stopping at `MAX_CONTROL_BODY_BYTES`. An
 * empty body is `undefined`, as `readBody` would see it on the laptop.
 */
function readBody(req: http.IncomingMessage): Promise<BodyResult> {
  const tooLarge: BodyResult = {
    ok: false,
    status: 413,
    error: `request body is over the ${MAX_CONTROL_BODY_BYTES}-byte limit`,
  };
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_CONTROL_BODY_BYTES) {
    req.resume();
    return Promise.resolve(tooLarge);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) {
        chunks.length = 0;
        // Answer now; the rest of the body is read and discarded.
        settle(tooLarge);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (text.trim() === "") {
        settle({ ok: true, body: undefined });
        return;
      }
      try {
        settle({ ok: true, body: JSON.parse(text) });
      } catch {
        settle({ ok: false, status: 400, error: "request body is not valid JSON" });
      }
    });
    req.on("error", () => settle({ ok: false, status: 400, error: "request aborted" }));
  });
}

export class ControlRelayListener {
  private server: http.Server | null = null;
  private listenPort = 0;
  private starting: Promise<number> | null = null;

  constructor(private readonly opts: ControlRelayListenerOptions) {}

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

  private async handle(
    token: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!tokenMatches(req.headers[CONTROL_TOKEN_HEADER], token)) {
      req.resume();
      reply(res, 403, { error: "Missing or wrong Manor control token" });
      return;
    }
    const read = await readBody(req);
    if (!read.ok) {
      reply(res, read.status, { error: read.error });
      return;
    }
    const pending = this.opts.relay({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      body: read.body,
    });
    const { status, body } = pending ? await pending : NOT_CONNECTED;
    reply(res, status, body);
  }

  private listen(): Promise<number> {
    const log = this.opts.log ?? (() => {});
    const token = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => {
      this.handle(token, req, res).catch((err: unknown) => {
        log(`control relay listener: request failed: ${errorMessage(err)}`);
        reply(res, 500, { error: errorMessage(err) });
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (err) => log(`control relay listener error: ${err.message}`));
        const addr = server.address();
        const port = addr && typeof addr === "object" ? addr.port : 0;
        this.server = server;
        this.listenPort = port;
        if (this.opts.portFile) {
          const env = this.opts.env ?? process.env;
          env.MANOR_CONTROL_PORT_FILE = this.opts.portFile;
          try {
            writePortFileAtomic(this.opts.portFile, port, token);
          } catch (err) {
            log(`control relay listener: could not write port file: ${errorMessage(err)}`);
          }
        }
        resolve(port);
      });
    });
  }
}

interface PendingRelay<S> {
  stream: S;
  resolve: (result: ControlRelayResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ControlRelayStreamsOptions<S> {
  /** Write one stream event to a stream socket. */
  send: (stream: S, event: StreamEvent) => void;
  /** Defaults to `CONTROL_RELAY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * The daemon's half of the relay: which stream socket gets `controlRequest`s,
 * and the requests still waiting on its `controlResponse`.
 *
 * The relay stream is the most recent stream socket that sent
 * `enableControlRelay`. Only one gets each request — relaying to every
 * connected app would run the request once per app. A reconnecting app
 * re-enables on its new socket, which takes over; requests already sent to
 * the old socket still resolve if it answers, or with a 503 when it closes.
 *
 * Generic over the socket type so it is testable without a daemon.
 */
export class ControlRelayStreams<S> {
  private relayStream: S | null = null;
  private readonly pending = new Map<string, PendingRelay<S>>();

  constructor(private readonly opts: ControlRelayStreamsOptions<S>) {}

  /** `stream` sent `enableControlRelay`: relay to it from now on. */
  enable(stream: S): void {
    this.relayStream = stream;
  }

  /**
   * `stream` sent a `controlResponse`. Ignored unless `id` is waiting on that
   * same socket — an id that already timed out, or one another socket
   * answers, is dropped.
   */
  respond(stream: S, id: string, status: number, body: unknown): void {
    const entry = this.pending.get(id);
    if (!entry || entry.stream !== stream) return;
    this.settle(id, { status, body });
  }

  /** `stream` closed: stop relaying to it and fail what it still owes with 503. */
  closed(stream: S): void {
    if (this.relayStream === stream) this.relayStream = null;
    for (const [id, entry] of this.pending) {
      if (entry.stream === stream) this.settle(id, NOT_CONNECTED);
    }
  }

  /** The `ControlRelay` the listener calls. */
  relay: ControlRelay = (req) => {
    const stream = this.relayStream;
    if (stream === null) return null;
    const id = crypto.randomUUID();
    const result = new Promise<ControlRelayResult>((resolve) => {
      const timer = setTimeout(
        () => this.settle(id, TIMED_OUT),
        this.opts.timeoutMs ?? CONTROL_RELAY_TIMEOUT_MS,
      );
      timer.unref?.();
      this.pending.set(id, { stream, resolve, timer });
    });
    this.opts.send(stream, {
      type: "controlRequest",
      id,
      method: req.method,
      path: req.path,
      body: req.body,
    });
    return result;
  };

  private settle(id: string, result: ControlRelayResult): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }
}
