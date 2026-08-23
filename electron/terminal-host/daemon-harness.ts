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
import { encodeFrame, MSG } from "./pty-subprocess-ipc";
import { TerminalHost } from "./terminal-host";
import type { Session } from "./session";
import type { ScrollbackWriter } from "./scrollback";
import type { ControlRequest, ControlResponse, StreamEvent } from "./types";

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

/** In-process daemon on a temp socket with a real TerminalHost + real sessionsDir */
export class E2EDaemon {
  private server: net.Server;
  private host: TerminalHost;
  private token: string;
  private authenticatedSockets = new WeakSet<net.Socket>();
  readonly socketPath: string;
  readonly sessionsDir: string;

  constructor(tmpDir: string) {
    this.sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.socketPath = path.join(tmpDir, "terminal-host.sock");
    this.token = crypto.randomBytes(16).toString("hex");
    this.host = new TerminalHost(this.sessionsDir);
    this.server = net.createServer((s) => this.handleConnection(s));
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
    this.host.disposeAll();
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
              if (msg.token === this.token)
                this.authenticatedSockets.add(socket);
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
    socket.on("close", () => this.host.detachAllFromSocket(socket));
  }

  private async handleControl(socket: net.Socket, line: string): Promise<void> {
    let req: ControlRequest;
    try {
      req = JSON.parse(line);
    } catch {
      this.send(socket, { type: "error", message: "Invalid JSON" });
      return;
    }
    if (req.type !== "auth" && !this.authenticatedSockets.has(socket)) {
      this.send(socket, { type: "error", message: "Not authenticated" });
      return;
    }
    switch (req.type) {
      case "auth":
        if (req.token === this.token) {
          this.authenticatedSockets.add(socket);
          this.send(socket, { type: "authOk" });
        } else {
          this.send(socket, { type: "error", message: "Invalid token" });
        }
        break;
      case "create":
        this.send(socket, {
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
        this.send(
          socket,
          snap
            ? { type: "attached", snapshot: snap }
            : { type: "error", message: "not found" },
        );
        break;
      }
      case "detach":
        this.host.detach(req.sessionId, socket);
        this.send(socket, { type: "detached" });
        break;
      case "resize":
        this.host.resize(req.sessionId, req.cols, req.rows);
        this.send(socket, { type: "resized" });
        break;
      case "kill":
        await this.host.kill(req.sessionId);
        this.send(socket, { type: "killed" });
        break;
      case "getSnapshot": {
        const snap = await this.host.getSnapshot(req.sessionId);
        this.send(
          socket,
          snap
            ? { type: "snapshot", snapshot: snap }
            : { type: "notFound", sessionId: req.sessionId },
        );
        break;
      }
      case "listSessions":
        this.send(socket, {
          type: "sessions",
          sessions: this.host.listSessions(),
        });
        break;
      case "ping":
        this.send(socket, { type: "pong" });
        break;
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
    else if (cmd.type === "subscribe") await this.host.attach(sessionId, socket);
    else if (cmd.type === "unsubscribe") this.host.detach(sessionId, socket);
  }

  private send(socket: net.Socket, resp: ControlResponse): void {
    socket.write(JSON.stringify(resp) + "\n");
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

/** Force-flush scrollback writer inside a session */
export function flushScrollback(host: TerminalHost, sessionId: string): void {
  const session = sessionOf(host, sessionId);
  if (!session) return;
  const { scrollbackWriter } = session as unknown as {
    scrollbackWriter: ScrollbackWriter | null;
  };
  scrollbackWriter?.flush();
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
