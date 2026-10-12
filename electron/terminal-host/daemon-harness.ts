/**
 * Shared harness for terminal-daemon tests: an in-process daemon on a temp
 * socket with a real TerminalHost, plus helpers for driving it.
 *
 * Not a test file. It lives here so protocol tests can each have their own
 * focused file instead of accumulating in one very long one — importing this
 * from a test that mocks `node:child_process` still gets the mocked subprocess,
 * since the mock applies to that test's whole module graph.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { encodeFrame, MSG, PTY_SUBPROCESS_PROTOCOL } from "./pty-subprocess-ipc";
import { TerminalHost } from "./terminal-host";
import { HookJournal } from "./hook-journal";
import type { Session } from "./session";
import type { ScrollbackWriter } from "./scrollback";
import {
  TERMINAL_HOST_PROTOCOL,
  type ControlRequest,
  type ControlResponse,
  type HookJournalEntry,
  type HookPayload,
  type StreamEvent,
} from "./types";

/** A line sent on the stream socket by a client. */
type StreamCommand = {
  type?: "write" | "subscribe" | "unsubscribe";
  sessionId?: string;
  data?: string;
};

/** Anything the daemon can send back on either socket. */
export type DaemonMessage = ControlResponse | StreamEvent;

/** Reach into a host's private session map — deliberate, for driving tests. */
function sessionOf(host: TerminalHost, sessionId: string): Session | undefined {
  return (host as unknown as { sessions: Map<string, Session> }).sessions.get(
    sessionId,
  );
}

/** Create a temp dir that gets cleaned up after the test */
export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manor-e2e-"));
}

/**
 * In-process daemon on a temp socket with a real TerminalHost + real
 * sessionsDir.
 *
 * Speaks enough of the real protocol for a `TerminalHostClient` too: replies
 * echo the request's `requestId`, `handshake` reports this build's protocols,
 * and — like the `remote` daemon role — it keeps a hook journal, answers
 * `replayHooks` from it, and broadcasts each journaled hook as a `hookEvent`
 * to every authenticated stream socket (`emitHook`).
 */
export class E2EDaemon {
  private server: net.Server;
  private host: TerminalHost;
  private token: string;
  private authenticatedSockets = new WeakSet<net.Socket>();
  private streamSockets = new Set<net.Socket>();
  readonly socketPath: string;
  readonly sessionsDir: string;
  readonly journal: HookJournal;

  constructor(tmpDir: string) {
    this.sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.socketPath = path.join(tmpDir, "terminal-host.sock");
    this.token = crypto.randomBytes(16).toString("hex");
    this.host = new TerminalHost(this.sessionsDir);
    this.journal = new HookJournal(path.join(tmpDir, "hook-journal.ndjson"));
    this.journal.open();
    this.server = net.createServer((s) => this.handleConnection(s));
  }

  /**
   * Journal one agent hook and broadcast it, as the remote daemon's hook
   * listener does for a hook script's request (ADR-178 §2).
   */
  emitHook(payload: HookPayload): HookJournalEntry {
    const entry = this.journal.append(payload);
    const event: StreamEvent = { type: "hookEvent", seq: entry.seq, payload };
    for (const socket of this.streamSockets) {
      if (!socket.destroyed) socket.write(JSON.stringify(event) + "\n");
    }
    return entry;
  }

  get authToken(): string {
    return this.token;
  }
  getHost(): TerminalHost {
    return this.host;
  }

  async start(): Promise<void> {
    return new Promise((r) => this.server.listen(this.socketPath, r));
  }

  async stop(): Promise<void> {
    await this.host.disposeAll();
    return new Promise((r) => {
      this.server.close(() => {
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          // Already gone.
        }
        r();
      });
    });
  }

  /** Stop without clean session dispose — simulates a crash */
  async crash(): Promise<void> {
    return new Promise((r) => {
      this.server.close(() => {
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          // Already gone.
        }
        r();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    let type: "control" | "stream" | null = null;
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        if (type === null) {
          try {
            const msg = JSON.parse(line);
            if (msg.connectionType === "stream") {
              type = "stream";
              if (msg.token === this.token) {
                this.authenticatedSockets.add(socket);
                this.streamSockets.add(socket);
              }
              continue;
            }
          } catch {
            // Not the stream handshake line — treat it as control below.
          }
          type = "control";
          this.handleControl(socket, line);
        } else if (type === "control") {
          this.handleControl(socket, line);
        } else {
          this.handleStream(socket, line);
        }
      }
    });
    // A client that goes away mid-write is a closed socket, not a test failure.
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.streamSockets.delete(socket);
      this.host.detachAllFromSocket(socket);
    });
  }

  private async handleControl(socket: net.Socket, line: string): Promise<void> {
    let req: ControlRequest & { requestId?: string };
    try {
      req = JSON.parse(line);
    } catch {
      this.send(socket, { type: "error", message: "Invalid JSON" });
      return;
    }
    // Every reply carries the request's id, as the real daemon's do; a raw
    // test client that sent none gets none back.
    const requestId = req.requestId;
    const send = (s: net.Socket, resp: ControlResponse): void =>
      this.send(s, resp, requestId);
    if (req.type !== "auth" && !this.authenticatedSockets.has(socket)) {
      send(socket, { type: "error", message: "Not authenticated" });
      return;
    }
    switch (req.type) {
      case "auth":
        if (req.token === this.token) {
          this.authenticatedSockets.add(socket);
          send(socket, { type: "authOk" });
        } else {
          send(socket, { type: "error", message: "Invalid token" });
        }
        break;
      case "create":
        send(socket, {
          type: "created",
          session: this.host.create(
            req.sessionId,
            req.cwd,
            req.cols,
            req.rows,
            req.shellArgs,
          ),
        });
        break;
      case "attach": {
        const snap = await this.host.attach(req.sessionId, socket);
        send(
          socket,
          snap
            ? { type: "attached", snapshot: snap }
            : { type: "error", message: "not found" },
        );
        break;
      }
      case "detach":
        this.host.detach(req.sessionId, socket);
        send(socket, { type: "detached" });
        break;
      case "resize":
        this.host.resize(req.sessionId, req.cols, req.rows);
        send(socket, { type: "resized" });
        break;
      case "kill":
        await this.host.kill(req.sessionId);
        send(socket, { type: "killed" });
        break;
      case "getSnapshot": {
        const snap = await this.host.getSnapshot(req.sessionId);
        send(
          socket,
          snap
            ? { type: "snapshot", snapshot: snap }
            : { type: "notFound", sessionId: req.sessionId },
        );
        break;
      }
      case "listSessions":
        send(socket, {
          type: "sessions",
          sessions: this.host.listSessions(),
        });
        break;
      case "ping":
        send(socket, { type: "pong" });
        break;
      case "handshake":
        send(socket, {
          type: "handshake",
          daemonVersion: "e2e",
          protocol: TERMINAL_HOST_PROTOCOL,
          ptyProtocol: PTY_SUBPROCESS_PROTOCOL,
        });
        break;
      case "updateEnv":
        send(socket, { type: "envUpdated" });
        break;
      case "getPaneFacts":
        send(socket, { type: "paneFacts", facts: this.host.getPaneFacts(req.sessionId) });
        break;
      case "replayHooks":
        send(socket, {
          type: "hookReplay",
          entries: req.headOnly ? [] : this.journal.since(Number(req.sinceSeq) || 0),
          lastSeq: this.journal.lastSeq,
          epoch: this.journal.epoch,
        });
        break;
      default:
        send(socket, { type: "error", message: `unsupported in the harness: ${req.type}` });
    }
  }

  private async handleStream(socket: net.Socket, line: string): Promise<void> {
    let cmd: StreamCommand;
    try {
      cmd = JSON.parse(line) as StreamCommand;
    } catch {
      return;
    }
    if (!this.authenticatedSockets.has(socket)) return;
    const sessionId = cmd.sessionId ?? "";
    if (cmd.type === "write") this.host.write(sessionId, cmd.data ?? "");
    else if (cmd.type === "subscribe") this.host.subscribe(sessionId, socket);
    else if (cmd.type === "unsubscribe") this.host.detach(sessionId, socket);
  }

  private send(socket: net.Socket, resp: ControlResponse, requestId?: string): void {
    const envelope = requestId === undefined ? resp : { ...resp, requestId };
    socket.write(JSON.stringify(envelope) + "\n");
  }
}

export function connectRaw(socketPath: string): Promise<{
  socket: net.Socket;
  send: (msg: unknown) => void;
  /**
   * Next message from the daemon. Typed loosely on purpose: tests assert on
   * response-specific fields, and narrowing at every call site would bury what
   * each test is actually checking.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readLine: () => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath, () => {
      let buf = "";
      const pending: Array<(value: DaemonMessage) => void> = [];
      const received: DaemonMessage[] = [];
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) {
          if (!l.trim()) continue;
          const message = JSON.parse(l) as DaemonMessage;
          if (pending.length > 0) pending.shift()!(message);
          else received.push(message);
        }
      });
      resolve({
        socket,
        send: (msg: unknown) => socket.write(JSON.stringify(msg) + "\n"),
        readLine: () =>
          new Promise<DaemonMessage>((r) => {
            if (received.length > 0) r(received.shift()!);
            else pending.push(r);
          }),
        close: () => socket.destroy(),
      });
    });
  });
}

export function feedSessionData(
  host: TerminalHost,
  sessionId: string,
  data: string,
): void {
  const session = sessionOf(host, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  (session as unknown as { decoder: { push: (frame: Buffer) => void } }).decoder.push(
    encodeFrame(MSG.DATA, data),
  );
}

/**
 * Force-flush scrollback writer inside a session — after the headless mirror
 * has parsed what was fed, since the CWD it writes to meta.json comes from it.
 */
export async function flushScrollback(
  host: TerminalHost,
  sessionId: string,
): Promise<void> {
  const session = sessionOf(host, sessionId);
  if (!session) return;
  const { flushHeadless, scrollbackWriter } = session as unknown as {
    flushHeadless: () => Promise<void>;
    scrollbackWriter: ScrollbackWriter | null;
  };
  await flushHeadless.call(session);
  await scrollbackWriter?.flush();
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
