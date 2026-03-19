import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { MSG, encodeFrame } from "./pty-subprocess-ipc";

import "./xterm-env-polyfill";

// Mock child_process.fork to avoid spawning real PTY subprocesses
vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    return {
      stdin,
      stdout,
      on: vi.fn(),
      kill: vi.fn(),
      pid: 55555,
    };
  }),
  spawn: vi.fn(),
}));

vi.mock("../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-test-zdotdir",
    historyFileFor: (id: string) => `/tmp/manor-test-sessions/${id}.history`,
    setupZdotdir: () => "/tmp/manor-test-zdotdir",
  },
}));

import { TerminalHost } from "./terminal-host";
import type { ControlRequest, ControlResponse, StreamEvent } from "./types";

/**
 * In-process daemon server for testing the socket protocol without
 * spawning a separate process. Replicates the logic from index.ts.
 */
class TestDaemon {
  private server: net.Server;
  private host = new TerminalHost();
  private token: string;
  private authenticatedSockets = new WeakSet<net.Socket>();
  readonly socketPath: string;

  constructor() {
    this.socketPath = path.join(os.tmpdir(), `manor-test-${crypto.randomUUID()}.sock`);
    this.token = crypto.randomBytes(16).toString("hex");
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  get authToken(): string {
    return this.token;
  }

  /** Get the underlying TerminalHost for feeding test data */
  getHost(): TerminalHost {
    return this.host;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.socketPath, resolve);
    });
  }

  async stop(): Promise<void> {
    this.host.disposeAll();
    return new Promise((resolve) => {
      this.server.close(() => {
        try { fs.unlinkSync(this.socketPath); } catch {}
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    let connectionType: "control" | "stream" | null = null;
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;

        if (connectionType === null) {
          try {
            const msg = JSON.parse(line);
            if (msg.connectionType === "stream") {
              connectionType = "stream";
              if (msg.token === this.token) {
                this.authenticatedSockets.add(socket);
              }
              continue;
            }
          } catch {}
          connectionType = "control";
          this.handleControlMessage(socket, line);
        } else if (connectionType === "control") {
          this.handleControlMessage(socket, line);
        } else {
          this.handleStreamMessage(socket, line);
        }
      }
    });

    socket.on("close", () => {
      this.host.detachAllFromSocket(socket);
    });
  }

  private async handleControlMessage(socket: net.Socket, line: string): Promise<void> {
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
      case "create": {
        const session = this.host.create(req.sessionId, req.cwd, req.cols, req.rows, req.shellArgs);
        this.send(socket, { type: "created", session });
        break;
      }
      case "attach": {
        const snapshot = await this.host.attach(req.sessionId, socket);
        if (snapshot) {
          this.send(socket, { type: "attached", snapshot });
        } else {
          this.send(socket, { type: "error", message: `Session ${req.sessionId} not found` });
        }
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
        this.host.kill(req.sessionId);
        this.send(socket, { type: "killed" });
        break;
      case "getSnapshot": {
        const snapshot = await this.host.getSnapshot(req.sessionId);
        if (snapshot) {
          this.send(socket, { type: "snapshot", snapshot });
        } else {
          this.send(socket, { type: "error", message: `Session ${req.sessionId} not found` });
        }
        break;
      }
      case "listSessions":
        this.send(socket, { type: "sessions", sessions: this.host.listSessions() });
        break;
      case "ping":
        this.send(socket, { type: "pong" });
        break;
    }
  }

  private async handleStreamMessage(socket: net.Socket, line: string): Promise<void> {
    let cmd: any;
    try { cmd = JSON.parse(line); } catch { return; }
    if (!this.authenticatedSockets.has(socket)) return;

    switch (cmd.type) {
      case "write":
        this.host.write(cmd.sessionId, cmd.data);
        break;
      case "subscribe":
        await this.host.attach(cmd.sessionId, socket);
        break;
      case "unsubscribe":
        this.host.detach(cmd.sessionId, socket);
        break;
    }
  }

  private send(socket: net.Socket, resp: ControlResponse): void {
    socket.write(JSON.stringify(resp) + "\n");
  }
}

/** Connect a raw socket to the daemon and provide NDJSON helpers */
function connectRaw(socketPath: string): Promise<{
  socket: net.Socket;
  send: (msg: any) => void;
  readLine: () => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath, () => {
      let buffer = "";
      const pending: Array<(value: any) => void> = [];
      const received: any[] = [];

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (pending.length > 0) {
            pending.shift()!(parsed);
          } else {
            received.push(parsed);
          }
        }
      });

      resolve({
        socket,
        send: (msg: any) => socket.write(JSON.stringify(msg) + "\n"),
        readLine: () => new Promise((res) => {
          if (received.length > 0) {
            res(received.shift());
          } else {
            pending.push(res);
          }
        }),
        close: () => socket.destroy(),
      });
    });
  });
}

/** Push data into a session via the host's internal session decoder */
function feedSessionData(host: TerminalHost, sessionId: string, data: string): void {
  const session = (host as any).sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const frame = encodeFrame(MSG.DATA, data);
  (session as any).decoder.push(frame);
}

describe("Daemon protocol (in-process)", () => {
  let daemon: TestDaemon;

  beforeEach(async () => {
    daemon = new TestDaemon();
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  describe("auth", () => {
    it("accepts valid token", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      const resp = await client.readLine();
      expect(resp.type).toBe("authOk");
      client.close();
    });

    it("rejects invalid token", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: "wrong-token" });
      const resp = await client.readLine();
      expect(resp.type).toBe("error");
      expect(resp.message).toContain("Invalid token");
      client.close();
    });

    it("rejects unauthenticated requests", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "ping" });
      const resp = await client.readLine();
      expect(resp.type).toBe("error");
      expect(resp.message).toContain("Not authenticated");
      client.close();
    });
  });

  describe("ping", () => {
    it("responds to ping after auth", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      await client.readLine(); // authOk

      client.send({ type: "ping" });
      const resp = await client.readLine();
      expect(resp.type).toBe("pong");
      client.close();
    });
  });

  describe("session lifecycle over socket", () => {
    it("creates a session", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      await client.readLine();

      client.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      const resp = await client.readLine();
      expect(resp.type).toBe("created");
      expect(resp.session.sessionId).toBe("s1");
      client.close();
    });

    it("lists sessions", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      await client.readLine();

      client.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await client.readLine();

      client.send({ type: "create", sessionId: "s2", cwd: "/home", cols: 120, rows: 40 });
      await client.readLine();

      client.send({ type: "listSessions" });
      const resp = await client.readLine();
      expect(resp.type).toBe("sessions");
      expect(resp.sessions).toHaveLength(2);
      client.close();
    });

    it("attaches to session and gets snapshot", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      await client.readLine();

      client.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await client.readLine();

      client.send({ type: "attach", sessionId: "s1" });
      const resp = await client.readLine();
      expect(resp.type).toBe("attached");
      expect(resp.snapshot).toBeDefined();
      expect(resp.snapshot.cols).toBe(80);
      client.close();
    });

    it("attach to nonexistent session returns error", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      await client.readLine();

      client.send({ type: "attach", sessionId: "nonexistent" });
      const resp = await client.readLine();
      expect(resp.type).toBe("error");
      client.close();
    });

    it("resize session", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      await client.readLine();

      client.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await client.readLine();

      client.send({ type: "resize", sessionId: "s1", cols: 120, rows: 40 });
      const resp = await client.readLine();
      expect(resp.type).toBe("resized");

      client.send({ type: "getSnapshot", sessionId: "s1" });
      const snap = await client.readLine();
      expect(snap.snapshot.cols).toBe(120);
      expect(snap.snapshot.rows).toBe(40);
      client.close();
    });

    it("kill session", async () => {
      const client = await connectRaw(daemon.socketPath);
      client.send({ type: "auth", token: daemon.authToken });
      await client.readLine();

      client.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await client.readLine();

      client.send({ type: "kill", sessionId: "s1" });
      const resp = await client.readLine();
      expect(resp.type).toBe("killed");
      client.close();
    });
  });

  describe("warm restore: session survives client disconnect", () => {
    it("session preserves content after client disconnects", async () => {
      // Client 1 creates session and writes data
      const client1 = await connectRaw(daemon.socketPath);
      client1.send({ type: "auth", token: daemon.authToken });
      await client1.readLine();

      client1.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await client1.readLine();

      // Simulate PTY output by feeding data directly into the host
      feedSessionData(daemon.getHost(), "s1", "important output that must survive");

      // Client 1 disconnects
      client1.close();
      // Small delay for socket close to propagate
      await new Promise((r) => setTimeout(r, 50));

      // Client 2 connects and attaches to the same session
      const client2 = await connectRaw(daemon.socketPath);
      client2.send({ type: "auth", token: daemon.authToken });
      await client2.readLine();

      client2.send({ type: "attach", sessionId: "s1" });
      const resp = await client2.readLine();
      expect(resp.type).toBe("attached");
      expect(resp.snapshot.screenAnsi).toContain("important output that must survive");
      client2.close();
    });

    it("session preserves CWD after client disconnects", async () => {
      const client1 = await connectRaw(daemon.socketPath);
      client1.send({ type: "auth", token: daemon.authToken });
      await client1.readLine();

      client1.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await client1.readLine();

      feedSessionData(daemon.getHost(), "s1", "\x1b]7;file://localhost/Users/restored\x07");

      client1.close();
      await new Promise((r) => setTimeout(r, 50));

      const client2 = await connectRaw(daemon.socketPath);
      client2.send({ type: "auth", token: daemon.authToken });
      await client2.readLine();

      client2.send({ type: "getSnapshot", sessionId: "s1" });
      const resp = await client2.readLine();
      expect(resp.snapshot.cwd).toBe("/Users/restored");
      client2.close();
    });

    it("session preserves modes after client disconnects", async () => {
      const client1 = await connectRaw(daemon.socketPath);
      client1.send({ type: "auth", token: daemon.authToken });
      await client1.readLine();

      client1.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await client1.readLine();

      feedSessionData(daemon.getHost(), "s1", "\x1b[?2004h\x1b[?1049h");

      client1.close();
      await new Promise((r) => setTimeout(r, 50));

      const client2 = await connectRaw(daemon.socketPath);
      client2.send({ type: "auth", token: daemon.authToken });
      await client2.readLine();

      client2.send({ type: "getSnapshot", sessionId: "s1" });
      const resp = await client2.readLine();
      expect(resp.snapshot.modes.bracketedPaste).toBe(true);
      expect(resp.snapshot.modes.altScreen).toBe(true);
      client2.close();
    });
  });

  describe("stream socket", () => {
    it("receives data events on stream socket", async () => {
      // Control socket: create session
      const control = await connectRaw(daemon.socketPath);
      control.send({ type: "auth", token: daemon.authToken });
      await control.readLine();

      control.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await control.readLine();

      // Stream socket: subscribe
      const stream = await connectRaw(daemon.socketPath);
      stream.send({ connectionType: "stream", token: daemon.authToken });
      // No response expected for stream init

      stream.send({ type: "subscribe", sessionId: "s1" });
      // Small delay for subscription to register
      await new Promise((r) => setTimeout(r, 50));

      // Feed data into the session
      feedSessionData(daemon.getHost(), "s1", "streamed data");

      const event = await stream.readLine();
      expect(event.type).toBe("data");
      expect(event.sessionId).toBe("s1");
      expect(event.data).toBe("streamed data");

      control.close();
      stream.close();
    });

    it("stops receiving after unsubscribe", async () => {
      const control = await connectRaw(daemon.socketPath);
      control.send({ type: "auth", token: daemon.authToken });
      await control.readLine();

      control.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await control.readLine();

      const stream = await connectRaw(daemon.socketPath);
      stream.send({ connectionType: "stream", token: daemon.authToken });

      stream.send({ type: "subscribe", sessionId: "s1" });
      await new Promise((r) => setTimeout(r, 50));

      stream.send({ type: "unsubscribe", sessionId: "s1" });
      await new Promise((r) => setTimeout(r, 50));

      feedSessionData(daemon.getHost(), "s1", "should not see this");

      // Wait briefly to see if anything comes through
      const received = await Promise.race([
        stream.readLine().then((data) => data),
        new Promise((r) => setTimeout(() => r(null), 200)),
      ]);

      expect(received).toBeNull();

      control.close();
      stream.close();
    });

    it("write via stream socket delivers to session", async () => {
      const control = await connectRaw(daemon.socketPath);
      control.send({ type: "auth", token: daemon.authToken });
      await control.readLine();

      control.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await control.readLine();

      const stream = await connectRaw(daemon.socketPath);
      stream.send({ connectionType: "stream", token: daemon.authToken });
      await new Promise((r) => setTimeout(r, 50));

      // Write via stream — this calls host.write which calls session.write
      // Since the subprocess is mocked, we can verify the data was written to stdin
      stream.send({ type: "write", sessionId: "s1", data: "user input" });
      await new Promise((r) => setTimeout(r, 50));

      // The write went through without error (no crash)
      control.send({ type: "ping" });
      const resp = await control.readLine();
      expect(resp.type).toBe("pong");

      control.close();
      stream.close();
    });
  });

  describe("multiple clients", () => {
    it("two clients see the same session data", async () => {
      // Create session via control
      const control = await connectRaw(daemon.socketPath);
      control.send({ type: "auth", token: daemon.authToken });
      await control.readLine();

      control.send({ type: "create", sessionId: "s1", cwd: "/tmp", cols: 80, rows: 24 });
      await control.readLine();

      // Two stream clients subscribe
      const stream1 = await connectRaw(daemon.socketPath);
      stream1.send({ connectionType: "stream", token: daemon.authToken });
      stream1.send({ type: "subscribe", sessionId: "s1" });

      const stream2 = await connectRaw(daemon.socketPath);
      stream2.send({ connectionType: "stream", token: daemon.authToken });
      stream2.send({ type: "subscribe", sessionId: "s1" });

      await new Promise((r) => setTimeout(r, 50));

      feedSessionData(daemon.getHost(), "s1", "shared output");

      const [event1, event2] = await Promise.all([
        stream1.readLine(),
        stream2.readLine(),
      ]);

      expect(event1.type).toBe("data");
      expect(event1.data).toBe("shared output");
      expect(event2.type).toBe("data");
      expect(event2.data).toBe("shared output");

      control.close();
      stream1.close();
      stream2.close();
    });
  });
});
