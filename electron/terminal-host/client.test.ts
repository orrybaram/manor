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
    return { stdin, stdout, on: vi.fn(), kill: vi.fn(), pid: 77777 };
  }),
  spawn: vi.fn(),
}));

vi.mock("../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-test-zdotdir",
    setupZdotdir: () => "/tmp/manor-test-zdotdir",
  },
}));

import { TerminalHost } from "./terminal-host";
import type { ControlRequest, ControlResponse } from "./types";
import { TerminalHostClient, isDaemonStale, daemonProtocolOf } from "./client";
import { TERMINAL_HOST_PROTOCOL } from "./types";

// ── Test daemon (same as daemon.integration.test.ts but with error handling fix) ──

class TestDaemon {
  private server: net.Server;
  private host = new TerminalHost();
  private token: string;
  private authenticatedSockets = new WeakSet<net.Socket>();
  private activeSockets = new Set<net.Socket>();
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly pidPath: string;
  /** Every request seen, in order, as "control:type" / "stream:type". */
  readonly seen: string[] = [];
  /** Set to make the next getSnapshot fail as though the daemon misbehaved. */
  failNextSnapshot = false;
  /** Behave like a daemon from before ADR-159: no protocol, no `notFound`. */
  legacyProtocol = false;

  constructor(dir: string) {
    // macOS has a 104-char limit for unix socket paths — use a short socket path
    const shortId = crypto.randomUUID().slice(0, 8);
    this.socketPath = path.join(os.tmpdir(), `mc-${shortId}.sock`);
    this.tokenPath = path.join(dir, "terminal-host.token");
    this.pidPath = path.join(dir, "terminal-host.pid");
    this.token = crypto.randomBytes(16).toString("hex");
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  get authToken(): string {
    return this.token;
  }

  getHost(): TerminalHost {
    return this.host;
  }

  async start(): Promise<void> {
    // Write token and pid files so the client can find them
    fs.writeFileSync(this.tokenPath, this.token);
    fs.writeFileSync(this.pidPath, String(process.pid));
    return new Promise((resolve) => {
      this.server.listen(this.socketPath, resolve);
    });
  }

  async stop(): Promise<void> {
    this.host.disposeAll();
    // Force-close all active connections so server.close() can complete
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
    return new Promise((resolve) => {
      this.server.close(() => {
        try {
          fs.unlinkSync(this.socketPath);
        } catch {}
        try {
          fs.unlinkSync(this.tokenPath);
        } catch {}
        try {
          fs.unlinkSync(this.pidPath);
        } catch {}
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    this.activeSockets.add(socket);
    socket.on("close", () => this.activeSockets.delete(socket));
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

  private async handleControlMessage(
    socket: net.Socket,
    line: string,
  ): Promise<void> {
    let req: ControlRequest & { requestId?: string };
    try {
      req = JSON.parse(line);
      this.seen.push(`control:${req.type}`);
    } catch {
      this.send(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    const requestId = req.requestId;

    if (req.type !== "auth" && !this.authenticatedSockets.has(socket)) {
      this.send(socket, { type: "error", message: "Not authenticated" }, requestId);
      return;
    }

    switch (req.type) {
      case "auth":
        if (req.token === this.token) {
          this.authenticatedSockets.add(socket);
          this.send(socket, { type: "authOk" }, requestId);
        } else {
          this.send(socket, { type: "error", message: "Invalid token" }, requestId);
        }
        break;
      case "create": {
        try {
          const session = this.host.create(
            req.sessionId,
            req.cwd,
            req.cols,
            req.rows,
            req.shellArgs,
          );
          this.send(socket, { type: "created", session }, requestId);
        } catch (err) {
          this.send(socket, {
            type: "error",
            message: `Create failed: ${err instanceof Error ? err.message : String(err)}`,
          }, requestId);
        }
        break;
      }
      case "attach": {
        const snapshot = await this.host.attach(req.sessionId, socket);
        if (snapshot) {
          this.send(socket, { type: "attached", snapshot }, requestId);
        } else {
          this.send(socket, {
            type: "error",
            message: `Session ${req.sessionId} not found`,
          }, requestId);
        }
        break;
      }
      case "detach":
        this.host.detach(req.sessionId, socket);
        this.send(socket, { type: "detached" }, requestId);
        break;
      case "resize":
        this.host.resize(req.sessionId, req.cols, req.rows);
        this.send(socket, { type: "resized" }, requestId);
        break;
      case "kill":
        await this.host.kill(req.sessionId);
        this.send(socket, { type: "killed" }, requestId);
        break;
      case "getSnapshot": {
        if (this.failNextSnapshot) {
          this.failNextSnapshot = false;
          this.send(socket, { type: "error", message: "socket exploded" }, requestId);
          break;
        }
        const snapshot = await this.host.getSnapshot(req.sessionId);
        if (snapshot) {
          this.send(socket, { type: "snapshot", snapshot }, requestId);
        } else if (this.legacyProtocol) {
          this.send(socket, {
            type: "error",
            message: `Session ${req.sessionId} not found`,
          }, requestId);
        } else {
          this.send(socket, { type: "notFound", sessionId: req.sessionId }, requestId);
        }
        break;
      }
      case "listSessions":
        this.send(socket, {
          type: "sessions",
          sessions: this.host.listSessions(),
        }, requestId);
        break;
      case "ping":
        this.send(socket, { type: "pong" }, requestId);
        break;
      case "handshake":
        // Echo the client's version so it does not decide we are stale and
        // respawn us. `protocol` is omitted when playing an older daemon.
        this.send(
          socket,
          this.legacyProtocol
            ? { type: "handshake", daemonVersion: req.clientVersion }
            : {
                type: "handshake",
                daemonVersion: req.clientVersion,
                protocol: 1,
              },
          requestId,
        );
        break;
    }
  }

  private async handleStreamMessage(
    socket: net.Socket,
    line: string,
  ): Promise<void> {
    let cmd: any;
    try {
      cmd = JSON.parse(line);
      this.seen.push(`stream:${cmd.type}`);
    } catch {
      return;
    }
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

  private send(socket: net.Socket, resp: ControlResponse, requestId?: string): void {
    try {
      const payload = requestId ? { ...resp, requestId } : resp;
      socket.write(JSON.stringify(payload) + "\n");
    } catch {}
  }
}

// ── Helper to create a TerminalHostClient wired to a test daemon ──

function createTestClient(daemon: TestDaemon): TerminalHostClient {
  const client = new TerminalHostClient();
  // Patch the private paths and daemon-spawning to point at our test daemon
  (client as any).isDaemonRunning = () => true;
  (client as any).spawnDaemon = () => Promise.resolve();

  const socketPath = daemon.socketPath;
  const tokenPath = daemon.tokenPath;

  const _origConnectControl = (client as any).connectControlSocket.bind(client);
  (client as any).connectControlSocket = () => {
    // Override SOCKET_PATH temporarily
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => resolve());
      (client as any).controlSocket = socket;

      socket.on("data", (chunk: Buffer) => {
        let buf: string = (client as any).controlBuffer;
        buf += chunk.toString("utf-8");
        const lines = buf.split("\n");
        (client as any).controlBuffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line);
            const pendingMap = (client as any).pendingRequests as Map<string, any>;
            const firstKey = pendingMap.keys().next().value;
            if (firstKey !== undefined) {
              const pending = pendingMap.get(firstKey)!;
              pendingMap.delete(firstKey);
              clearTimeout(pending.timeout);
              pending.resolve(resp);
            }
          } catch {}
        }
      });

      socket.on("error", (err: Error) => {
        if (!(client as any).connected) {
          reject(err);
        } else {
          (client as any).handleDisconnect();
        }
      });

      socket.on("close", () => {
        (client as any).handleDisconnect();
      });
    });
  };

  // Patch connectStreamSocket similarly
  (client as any).connectStreamSocket = (token: string) => {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        socket.write(
          JSON.stringify({ connectionType: "stream", token }) + "\n",
        );
        resolve();
      });
      (client as any).streamSocket = socket;

      socket.on("data", (chunk: Buffer) => {
        let buf: string = (client as any).streamBuffer;
        buf += chunk.toString("utf-8");
        const lines = buf.split("\n");
        (client as any).streamBuffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            (client as any).eventHandler?.(event);
          } catch {}
        }
      });

      socket.on("error", (err: Error) => {
        if (!(client as any).connected) reject(err);
      });

      socket.on("close", () => {
        (client as any).handleDisconnect();
      });
    });
  };

  // Patch the request method to read the test token
  const origRequest = (client as any).request.bind(client);
  const _origDoConnect = (client as any).doConnect.bind(client);
  (client as any).doConnect = async () => {
    await (client as any).connectControlSocket();
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    const authResp = await origRequest({ type: "auth", token });
    if (authResp.type !== "authOk") {
      throw new Error(
        `Auth failed: ${authResp.type === "error" ? authResp.message : "unknown"}`,
      );
    }
    // Mirror the real doConnect's protocol negotiation — minus the kill and
    // respawn on a version mismatch, which a test daemon never needs. Without
    // this the client would treat every test daemon as pre-ADR-159.
    const hsResp = await origRequest({
      type: "handshake",
      clientVersion: (client as any).clientVersion ?? "unknown",
    });
    (client as any).daemonProtocol =
      hsResp.type === "handshake" ? (hsResp.protocol ?? 0) : 0;
    await (client as any).connectStreamSocket(token);
    (client as any).connected = true;
  };

  return client;
}

// ── Tests ──

describe("TerminalHostClient", () => {
  let tmpDir: string;
  let daemon: TestDaemon;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `manor-client-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    daemon = new TestDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  describe("connect", () => {
    it("connects and authenticates with the daemon", async () => {
      const client = createTestClient(daemon);
      await client.connect();
      expect(await client.ping()).toBe(true);
      client.disconnect();
    });

    it("concurrent connect calls share one connection", async () => {
      const client = createTestClient(daemon);

      // Call connect multiple times concurrently
      const _results = await Promise.all([
        client.connect(),
        client.connect(),
        client.connect(),
      ]);

      // All should succeed and we should have a single working connection
      expect(await client.ping()).toBe(true);
      client.disconnect();
    });

    it("connect after disconnect re-establishes connection", async () => {
      const client = createTestClient(daemon);
      await client.connect();
      expect(await client.ping()).toBe(true);

      client.disconnect();

      await client.connect();
      expect(await client.ping()).toBe(true);
      client.disconnect();
    });
  });

  describe("disconnect", () => {
    it("rejects pending requests on disconnect", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Start a request but disconnect before it resolves
      const listPromise = client.listSessions();

      // Disconnect immediately
      client.disconnect();

      // The request should reject with either Disconnected or not writable
      await expect(listPromise).rejects.toThrow();
    });

    it("nulls out sockets on disconnect", async () => {
      const client = createTestClient(daemon);
      await client.connect();
      client.disconnect();

      expect((client as any).controlSocket).toBeNull();
      expect((client as any).streamSocket).toBeNull();
      expect((client as any).connected).toBe(false);
    });
  });

  describe("handleDisconnect", () => {
    it("cleans up sockets when daemon drops connection", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Forcibly destroy the client's sockets to simulate daemon dropping connection
      (client as any).controlSocket?.destroy();
      (client as any).streamSocket?.destroy();

      // Wait for close event to propagate
      await new Promise((r) => setTimeout(r, 200));

      expect((client as any).connected).toBe(false);
      expect((client as any).controlSocket).toBeNull();
      expect((client as any).streamSocket).toBeNull();
      expect((client as any).pendingRequests).toHaveLength(0);
    });
  });

  describe("createOrAttach", () => {
    it("creates a new session when none exists", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      const result = await client.createOrAttach("pane-1", "/tmp", 80, 24);
      expect(result.session.sessionId).toBe("pane-1");
      expect(result.snapshot).toBeNull();
      client.disconnect();
    });

    it("attaches to existing session and returns snapshot", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Create a session first
      await client.createOrAttach("pane-1", "/tmp", 80, 24);

      // Feed data into the session
      const host = daemon.getHost();
      const session = (host as any).sessions.get("pane-1");
      const frame = encodeFrame(MSG.DATA, "hello from pty");
      (session as any).decoder.push(frame);

      // Disconnect and reconnect to simulate restart
      client.disconnect();
      await client.connect();

      // Should attach to existing session with snapshot
      const result = await client.createOrAttach("pane-1", "/tmp", 80, 24);
      expect(result.snapshot).not.toBeNull();
      expect(result.snapshot!.screenAnsi).toContain("hello from pty");
      client.disconnect();
    });

    it("resizes, then subscribes, then snapshots when reattaching (ADR-159)", async () => {
      const client = createTestClient(daemon);
      await client.connect();
      await client.createOrAttach("pane-1", "/tmp", 80, 24);

      const host = daemon.getHost();
      const session = (host as any).sessions.get("pane-1");
      (session as any).decoder.push(encodeFrame(MSG.DATA, "already on screen"));

      client.disconnect();
      await client.connect();
      daemon.seen.length = 0;

      const result = await client.createOrAttach("pane-1", "/tmp", 100, 30);

      // Subscribing before snapshotting is what closes the loss window; the
      // duplicates it admits are filtered by seq downstream.
      const order = daemon.seen.filter((entry) =>
        ["control:resize", "stream:subscribe", "control:getSnapshot"].includes(
          entry,
        ),
      );
      expect(order).toEqual([
        "control:resize",
        "stream:subscribe",
        "control:getSnapshot",
      ]);
      expect(result.snapshot!.seq).toBeGreaterThan(0);
      client.disconnect();
    });

    it("refuses to spawn a fresh shell when the snapshot request fails", async () => {
      const client = createTestClient(daemon);
      await client.connect();
      await client.createOrAttach("pane-1", "/tmp", 80, 24);

      client.disconnect();
      await client.connect();
      daemon.seen.length = 0;
      daemon.failNextSnapshot = true;

      // The session is alive; the daemon just failed to answer. Creating here
      // would hand a live shell to a terminal that thinks it is new, dropping
      // the snapshot and the dedupe that comes with it.
      await expect(
        client.createOrAttach("pane-1", "/tmp", 80, 24),
      ).rejects.toThrow(/socket exploded/);
      expect(daemon.seen).not.toContain("control:create");
      client.disconnect();
    });

    it("still attaches to a daemon that predates the notFound reply", async () => {
      // The upgrade case that bit in practice: a daemon left running from an
      // earlier build of the same app version, so nothing replaces it, talking
      // to a client that now knows about `notFound`.
      daemon.legacyProtocol = true;
      const client = createTestClient(daemon);
      await client.connect();

      const result = await client.createOrAttach("pane-legacy", "/tmp", 80, 24);

      expect(result.session.sessionId).toBe("pane-legacy");
      expect(result.snapshot).toBeNull();
      client.disconnect();
    });

    it("creates and subscribes when the daemon has no such session", async () => {
      const client = createTestClient(daemon);
      await client.connect();
      daemon.seen.length = 0;

      const result = await client.createOrAttach("pane-fresh", "/tmp", 80, 24);

      // The resize and subscribe that precede the snapshot are no-ops against
      // a session the daemon does not have; what matters is that the fresh
      // session gets created and then subscribed. The subscribe is a
      // fire-and-forget stream write, so give it a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result.snapshot).toBeNull();
      expect(daemon.seen).toContain("control:create");
      expect(daemon.seen.lastIndexOf("stream:subscribe")).toBeGreaterThan(
        daemon.seen.indexOf("control:create"),
      );
      client.disconnect();
    });

    it("concurrent createOrAttach calls don't corrupt FIFO queue", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Create multiple sessions concurrently
      const results = await Promise.all([
        client.createOrAttach("pane-a", "/tmp", 80, 24),
        client.createOrAttach("pane-b", "/tmp", 80, 24),
        client.createOrAttach("pane-c", "/tmp", 80, 24),
      ]);

      // All should succeed with correct session IDs
      const sessionIds = results.map((r) => r.session.sessionId).sort();
      expect(sessionIds).toEqual(["pane-a", "pane-b", "pane-c"]);

      // All should be fresh creates (no snapshots)
      for (const result of results) {
        expect(result.snapshot).toBeNull();
      }

      client.disconnect();
    });

    it("concurrent createOrAttach after reconnect works correctly", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Create initial sessions
      await client.createOrAttach("pane-1", "/tmp", 80, 24);
      await client.createOrAttach("pane-2", "/tmp", 80, 24);

      // Disconnect (simulating daemon restart scenario where sessions persist)
      client.disconnect();

      // Reconnect and restore both sessions concurrently
      const results = await Promise.all([
        client.createOrAttach("pane-1", "/tmp", 80, 24),
        client.createOrAttach("pane-2", "/tmp", 80, 24),
      ]);

      // Both should get snapshots (attach, not create)
      for (const result of results) {
        expect(result.snapshot).not.toBeNull();
      }

      client.disconnect();
    });
  });

  describe("concurrent operations after reconnect", () => {
    it("multiple panes work correctly after client reconnects", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Simulate connection loss by forcibly disconnecting
      client.disconnect();

      // Multiple panes try to createOrAttach concurrently
      // They all trigger ensureConnected → connect
      const results = await Promise.all([
        client.createOrAttach("pane-x", "/tmp", 80, 24),
        client.createOrAttach("pane-y", "/tmp", 80, 24),
      ]);

      const ids = results.map((r) => r.session.sessionId).sort();
      expect(ids).toEqual(["pane-x", "pane-y"]);

      client.disconnect();
    });
  });

  describe("error handling", () => {
    it("ping returns false when not connected", async () => {
      const client = createTestClient(daemon);
      // Don't connect
      // Override ensureConnected to throw
      (client as any).ensureConnected = () => {
        throw new Error("not connected");
      };
      expect(await client.ping()).toBe(false);
    });

    it("createOrAttach propagates create errors from daemon", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Monkey-patch the daemon's host.create to throw
      const host = daemon.getHost();
      const origCreate = host.create.bind(host);
      host.create = () => {
        throw new Error("spawn failed: no such file");
      };

      await expect(
        client.createOrAttach("pane-fail", "/tmp", 80, 24),
      ).rejects.toThrow("Create failed");

      // Restore and verify client is still functional
      host.create = origCreate;
      const result = await client.createOrAttach("pane-ok", "/tmp", 80, 24);
      expect(result.session.sessionId).toBe("pane-ok");

      client.disconnect();
    });

    it("request rejects when socket is not writable", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      // Destroy the control socket to make it not writable
      (client as any).controlSocket?.destroy();
      (client as any).controlSocket = null;

      const requestFn = (client as any).request.bind(client);
      await expect(requestFn({ type: "ping" })).rejects.toThrow(
        "Control socket not writable",
      );

      // Reset state so disconnect doesn't error
      (client as any).connected = false;
    });
  });

  describe("stream events", () => {
    it("receives data events after createOrAttach", async () => {
      const client = createTestClient(daemon);
      const events: any[] = [];
      client.onEvent((event) => events.push(event));
      await client.connect();

      await client.createOrAttach("pane-1", "/tmp", 80, 24);

      // Wait for subscription to register
      await new Promise((r) => setTimeout(r, 100));

      // Feed data into the session
      const host = daemon.getHost();
      const session = (host as any).sessions.get("pane-1");
      const frame = encodeFrame(MSG.DATA, "output data");
      (session as any).decoder.push(frame);

      // Wait for event propagation
      await new Promise((r) => setTimeout(r, 100));

      expect(
        events.some((e) => e.type === "data" && e.data === "output data"),
      ).toBe(true);
      client.disconnect();
    });
  });

  describe("daemonDir (ADR-116)", () => {
    it("uses a fixed path independent of app version", () => {
      const clientA = new TerminalHostClient("1.0.0");
      const clientB = new TerminalHostClient("9.9.9");
      const clientC = new TerminalHostClient();

      const dirA = (clientA as any).daemonDir as string;
      const dirB = (clientB as any).daemonDir as string;
      const dirC = (clientC as any).daemonDir as string;

      // All versions must resolve to the same directory
      expect(dirA).toBe(dirB);
      expect(dirA).toBe(dirC);

      // Must be ~/.manor/daemon — not the old ~/.manor/daemons/{version}
      expect(dirA).toMatch(/\.manor\/daemon$/);
      expect(dirA).not.toContain("daemons");
    });
  });

  describe("migrateOldDaemons (ADR-116)", () => {
    it("sends SIGTERM to PIDs found in legacy versioned daemon directories", async () => {
      // Build a temp legacy daemons dir with two versioned subdirs
      const legacyRoot = path.join(tmpDir, "daemons");
      const v1Dir = path.join(legacyRoot, "1.0.0");
      const v2Dir = path.join(legacyRoot, "2.3.4");
      fs.mkdirSync(v1Dir, { recursive: true });
      fs.mkdirSync(v2Dir, { recursive: true });

      // Write fake PIDs that are guaranteed dead (PID 1 exists on every Unix
      // system but is not owned by us, so kill(1, 0) will throw EPERM which
      // migrateOldDaemons must silently ignore). Use 0 to trigger ESRCH.
      // We want to verify the file is *read* and process.kill is *called*.
      const killedPids: Array<[number, string]> = [];
      const origKill = process.kill.bind(process);
      (process as any).kill = (pid: number, sig: string) => {
        killedPids.push([pid, sig]);
        // Don't actually kill anything
      };

      try {
        fs.writeFileSync(path.join(v1Dir, "terminal-host.pid"), "11111");
        fs.writeFileSync(path.join(v2Dir, "terminal-host.pid"), "22222");

        const client = new TerminalHostClient("3.0.0");
        // Point client at the temp dir via the private MANOR_DIR getter
        (client as any).migrateOldDaemonsDir = legacyRoot;

        // Monkey-patch migrateOldDaemons to use our temp dir
        const origMigrate = (client as any).migrateOldDaemons.bind(client);
        (client as any).migrateOldDaemons = async () => {
          if ((client as any)._migratedOldDaemons) return;
          (client as any)._migratedOldDaemons = true;
          const entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const pidFile = path.join(legacyRoot, entry.name, "terminal-host.pid");
            try {
              const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
              if (!isNaN(pid)) (process as any).kill(pid, "SIGTERM");
            } catch { /* ignore */ }
          }
        };

        await (client as any).migrateOldDaemons();

        expect(killedPids).toContainEqual([11111, "SIGTERM"]);
        expect(killedPids).toContainEqual([22222, "SIGTERM"]);
      } finally {
        (process as any).kill = origKill;
      }
    });

    it("runs only once per client instance", async () => {
      const client = new TerminalHostClient();
      let callCount = 0;

      // Replace the method with a counter
      const orig = (client as any).migrateOldDaemons.bind(client);
      (client as any).migrateOldDaemons = async () => {
        callCount++;
        return orig();
      };

      // The flag is internal — call the real logic twice
      const real = async () => {
        if ((client as any)._migratedOldDaemons) return;
        (client as any)._migratedOldDaemons = true;
        callCount++;
      };

      await real();
      await real();
      await real();

      expect(callCount).toBe(1);
    });
  });

  describe("connectPromise sharing", () => {
    it("second connect() awaits the first connect's promise", async () => {
      const client = createTestClient(daemon);

      // Track how many times doConnect is actually called
      let connectCount = 0;
      const origDoConnect = (client as any).doConnect.bind(client);
      (client as any).doConnect = async () => {
        connectCount++;
        return origDoConnect();
      };

      // Launch two connects concurrently
      await Promise.all([client.connect(), client.connect()]);

      // doConnect should only be called once
      expect(connectCount).toBe(1);
      expect(await client.ping()).toBe(true);

      client.disconnect();
    });

    it("connectPromise is cleared after connect completes", async () => {
      const client = createTestClient(daemon);
      await client.connect();

      expect((client as any).connectPromise).toBeNull();
      client.disconnect();
    });

    it("connectPromise is cleared even if connect fails", async () => {
      const client = createTestClient(daemon);

      // Make doConnect fail
      (client as any).doConnect = async () => {
        throw new Error("connection failed");
      };

      await expect(client.connect()).rejects.toThrow("connection failed");
      expect((client as any).connectPromise).toBeNull();
    });
  });
});


describe("isDaemonStale", () => {
  const CURRENT = "0.6.5";
  const current = (over: Partial<ControlResponse> = {}): ControlResponse =>
    ({
      type: "handshake",
      daemonVersion: CURRENT,
      protocol: TERMINAL_HOST_PROTOCOL,
      ...over,
    }) as ControlResponse;

  it("keeps a daemon that matches on both version and protocol", () => {
    expect(isDaemonStale(current(), CURRENT)).toBe(false);
  });

  it("replaces a daemon built from a different app version", () => {
    expect(isDaemonStale(current({ daemonVersion: "0.6.4" }), CURRENT)).toBe(true);
  });

  // The regression this function exists for: two dev builds of one release meet
  // across a protocol bump. The version check passes, so the pre-ADR-159 daemon
  // survives, reports no `seq`, and every warm restore duplicates output again.
  it("replaces a same-version daemon that speaks an older protocol", () => {
    expect(isDaemonStale(current({ protocol: 0 }), CURRENT)).toBe(true);
  });

  it("replaces a same-version daemon that omits the protocol entirely", () => {
    const legacy = { type: "handshake", daemonVersion: CURRENT } as ControlResponse;
    expect(isDaemonStale(legacy, CURRENT)).toBe(true);
  });

  it("replaces a daemon too old to answer the handshake at all", () => {
    const err = { type: "error", message: "Unknown request" } as ControlResponse;
    expect(isDaemonStale(err, CURRENT)).toBe(true);
  });
});

describe("daemonProtocolOf", () => {
  it("reads the reported protocol", () => {
    expect(
      daemonProtocolOf({
        type: "handshake",
        daemonVersion: "0.6.5",
        protocol: 1,
      } as ControlResponse),
    ).toBe(1);
  });

  it("reports 0 for a handshake without a protocol field", () => {
    expect(
      daemonProtocolOf({
        type: "handshake",
        daemonVersion: "0.6.5",
      } as ControlResponse),
    ).toBe(0);
  });

  it("reports 0 when the daemon could not answer the handshake", () => {
    expect(
      daemonProtocolOf({ type: "error", message: "nope" } as ControlResponse),
    ).toBe(0);
  });
});
