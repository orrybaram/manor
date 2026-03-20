/**
 * End-to-end tests for the terminal daemon architecture.
 *
 * These tests exercise the full pipeline: daemon socket server → session →
 * scrollback persistence → layout persistence → warm/cold restore.
 *
 * Uses real temp directories for all I/O (no filesystem mocks).
 * PTY subprocesses are still mocked since we don't need real shells.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { MSG, encodeFrame } from "./pty-subprocess-ipc";

import "./xterm-env-polyfill";

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
    zdotdirPath: () => "/tmp/manor-e2e-zdotdir",
    historyFileFor: (id: string) => `/tmp/manor-e2e-sessions/${id}.history`,
    setupZdotdir: () => "/tmp/manor-e2e-zdotdir",
  },
}));

import { TerminalHost } from "./terminal-host";
import { ScrollbackWriter, type SessionMeta } from "./scrollback";
import {
  LayoutPersistence,
  type PersistedWorkspace,
  type PersistedSession,
} from "./layout-persistence";
import type { ControlRequest, ControlResponse } from "./types";

// ── Helpers ──

/** Create a temp dir that gets cleaned up after the test */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manor-e2e-"));
}

/** In-process daemon on a temp socket with a real TerminalHost + real sessionsDir */
class E2EDaemon {
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
        } catch {}
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
        } catch {}
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
          } catch {}
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
        this.host.kill(req.sessionId);
        this.send(socket, { type: "killed" });
        break;
      case "getSnapshot": {
        const snap = await this.host.getSnapshot(req.sessionId);
        this.send(
          socket,
          snap
            ? { type: "snapshot", snapshot: snap }
            : { type: "error", message: "not found" },
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
    let cmd: any;
    try {
      cmd = JSON.parse(line);
    } catch {
      return;
    }
    if (!this.authenticatedSockets.has(socket)) return;
    if (cmd.type === "write") this.host.write(cmd.sessionId, cmd.data);
    else if (cmd.type === "subscribe")
      await this.host.attach(cmd.sessionId, socket);
    else if (cmd.type === "unsubscribe")
      this.host.detach(cmd.sessionId, socket);
  }

  private send(socket: net.Socket, resp: ControlResponse): void {
    socket.write(JSON.stringify(resp) + "\n");
  }
}

function connectRaw(socketPath: string): Promise<{
  socket: net.Socket;
  send: (msg: any) => void;
  readLine: () => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath, () => {
      let buf = "";
      const pending: Array<(v: any) => void> = [];
      const received: any[] = [];
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) {
          if (!l.trim()) continue;
          const p = JSON.parse(l);
          if (pending.length > 0) pending.shift()!(p);
          else received.push(p);
        }
      });
      resolve({
        socket,
        send: (msg: any) => socket.write(JSON.stringify(msg) + "\n"),
        readLine: () =>
          new Promise((r) => {
            if (received.length > 0) r(received.shift());
            else pending.push(r);
          }),
        close: () => socket.destroy(),
      });
    });
  });
}

function feedSessionData(
  host: TerminalHost,
  sessionId: string,
  data: string,
): void {
  const session = (host as any).sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  (session as any).decoder.push(encodeFrame(MSG.DATA, data));
}

/** Force-flush scrollback writer inside a session */
function flushScrollback(host: TerminalHost, sessionId: string): void {
  const session = (host as any).sessions.get(sessionId);
  if (!session) return;
  const writer = (session as any).scrollbackWriter as ScrollbackWriter | null;
  writer?.flush();
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Tests ──

describe("E2E: scrollback persistence through daemon", () => {
  let tmpDir: string;
  let daemon: E2EDaemon;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    daemon = new E2EDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creating a session via socket writes meta.json and scrollback.bin to disk", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp/test",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Session dir should exist
    const sessionDir = path.join(daemon.sessionsDir, "s1");
    expect(fs.existsSync(sessionDir)).toBe(true);

    // meta.json should have correct content
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    ) as SessionMeta;
    expect(meta.sessionId).toBe("s1");
    expect(meta.cwd).toBe("/tmp/test");
    expect(meta.cols).toBe(80);
    expect(meta.rows).toBe(24);
    expect(meta.endedAt).toBeNull();

    // scrollback.bin should exist (empty initially)
    expect(fs.existsSync(path.join(sessionDir, "scrollback.bin"))).toBe(true);

    client.close();
  });

  it("PTY output is written to scrollback.bin on disk", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Feed data into the session
    feedSessionData(daemon.getHost(), "s1", "hello from the PTY\r\n");
    feedSessionData(daemon.getHost(), "s1", "second line of output\r\n");

    // Force flush (normally buffered for 2s)
    flushScrollback(daemon.getHost(), "s1");

    const scrollback = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(scrollback).toContain("hello from the PTY");
    expect(scrollback).toContain("second line of output");

    client.close();
  });

  it("OSC 7 CWD change updates meta.json on disk", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/start",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    feedSessionData(
      daemon.getHost(),
      "s1",
      "\x1b]7;file://localhost/Users/new/dir\x07",
    );
    flushScrollback(daemon.getHost(), "s1");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(daemon.sessionsDir, "s1", "meta.json"),
        "utf-8",
      ),
    ) as SessionMeta;
    expect(meta.cwd).toBe("/Users/new/dir");

    client.close();
  });

  it("killing a session marks endedAt in meta.json", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Dispose the session (simulates clean shutdown)
    daemon.getHost().disposeSession("s1");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(daemon.sessionsDir, "s1", "meta.json"),
        "utf-8",
      ),
    ) as SessionMeta;
    expect(meta.endedAt).not.toBeNull();

    client.close();
  });

  it("unclean shutdown detection: meta.json has no endedAt", async () => {
    const client = await connectRaw(daemon.socketPath);
    client.send({ type: "auth", token: daemon.authToken });
    await client.readLine();

    client.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await client.readLine();

    // Session is alive — endedAt should be null
    expect(ScrollbackWriter.isUncleanShutdown("s1", daemon.sessionsDir)).toBe(
      true,
    );

    // After clean end
    daemon.getHost().disposeSession("s1");
    expect(ScrollbackWriter.isUncleanShutdown("s1", daemon.sessionsDir)).toBe(
      false,
    );

    client.close();
  });
});

describe("E2E: warm restore through daemon sockets", () => {
  let tmpDir: string;
  let daemon: E2EDaemon;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    daemon = new E2EDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("client1 writes data, disconnects; client2 attaches and gets snapshot with data + scrollback on disk", async () => {
    // Client 1: create session, write data
    const c1 = await connectRaw(daemon.socketPath);
    c1.send({ type: "auth", token: daemon.authToken });
    await c1.readLine();

    c1.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await c1.readLine();

    feedSessionData(daemon.getHost(), "s1", "important output");
    flushScrollback(daemon.getHost(), "s1");

    // Disconnect client 1
    c1.close();
    await delay(50);

    // Verify scrollback on disk
    const scrollback = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(scrollback).toContain("important output");

    // Client 2: attach and get snapshot
    const c2 = await connectRaw(daemon.socketPath);
    c2.send({ type: "auth", token: daemon.authToken });
    await c2.readLine();

    c2.send({ type: "attach", sessionId: "s1" });
    const resp = await c2.readLine();

    expect(resp.type).toBe("attached");
    expect(resp.snapshot.screenAnsi).toContain("important output");

    c2.close();
  });

  it("warm restore preserves CWD, modes, and continues streaming", async () => {
    const c1 = await connectRaw(daemon.socketPath);
    c1.send({ type: "auth", token: daemon.authToken });
    await c1.readLine();

    c1.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await c1.readLine();

    feedSessionData(
      daemon.getHost(),
      "s1",
      "\x1b]7;file://localhost/restored/cwd\x07",
    );
    feedSessionData(daemon.getHost(), "s1", "\x1b[?2004h"); // bracketed paste on

    c1.close();
    await delay(50);

    // Client 2 attaches
    const c2 = await connectRaw(daemon.socketPath);
    c2.send({ type: "auth", token: daemon.authToken });
    await c2.readLine();

    c2.send({ type: "getSnapshot", sessionId: "s1" });
    const snap = await c2.readLine();

    expect(snap.snapshot.cwd).toBe("/restored/cwd");
    expect(snap.snapshot.modes.bracketedPaste).toBe(true);

    // Subscribe to stream and verify new data flows
    const stream = await connectRaw(daemon.socketPath);
    stream.send({ connectionType: "stream", token: daemon.authToken });
    stream.send({ type: "subscribe", sessionId: "s1" });
    await delay(50);

    feedSessionData(daemon.getHost(), "s1", "new data after reattach");

    const event = await stream.readLine();
    expect(event.type).toBe("data");
    expect(event.data).toBe("new data after reattach");

    c2.close();
    stream.close();
  });
});

describe("E2E: cold restore from scrollback on disk", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scrollback written by daemon1 is readable after daemon1 dies and daemon2 starts", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");

    // Daemon 1: create session, write data, stop abruptly (no clean end)
    const daemon1 = new E2EDaemon(tmpDir);
    await daemon1.start();

    const c1 = await connectRaw(daemon1.socketPath);
    c1.send({ type: "auth", token: daemon1.authToken });
    await c1.readLine();

    c1.send({
      type: "create",
      sessionId: "s1",
      cwd: "/project/code",
      cols: 120,
      rows: 40,
    });
    await c1.readLine();

    feedSessionData(daemon1.getHost(), "s1", "$ git status\r\n");
    feedSessionData(daemon1.getHost(), "s1", "On branch main\r\n");
    feedSessionData(
      daemon1.getHost(),
      "s1",
      "nothing to commit, working tree clean\r\n",
    );
    flushScrollback(daemon1.getHost(), "s1");

    c1.close();
    // Stop daemon1 WITHOUT clean session end (simulate crash)
    await daemon1.crash();

    // Verify: meta.json exists, endedAt is null (unclean), scrollback has content
    expect(ScrollbackWriter.isUncleanShutdown("s1", sessionsDir)).toBe(true);

    const meta = ScrollbackWriter.readMeta("s1", sessionsDir);
    expect(meta).not.toBeNull();
    expect(meta!.cwd).toBe("/project/code");
    expect(meta!.cols).toBe(120);
    expect(meta!.rows).toBe(40);

    const scrollback = ScrollbackWriter.readScrollback("s1", sessionsDir);
    expect(scrollback).toContain("git status");
    expect(scrollback).toContain("nothing to commit");

    // Daemon 2: session "s1" is gone from memory, but scrollback is on disk
    const daemon2 = new E2EDaemon(tmpDir);
    await daemon2.start();

    const c2 = await connectRaw(daemon2.socketPath);
    c2.send({ type: "auth", token: daemon2.authToken });
    await c2.readLine();

    // Session s1 doesn't exist in daemon2
    c2.send({ type: "attach", sessionId: "s1" });
    const attachResp = await c2.readLine();
    expect(attachResp.type).toBe("error"); // not found — daemon2 never had it

    // But we can read scrollback from disk for cold restore
    const coldScrollback = ScrollbackWriter.readScrollback("s1", sessionsDir);
    expect(coldScrollback).toContain("git status");
    expect(coldScrollback).toContain("nothing to commit");

    // Create a new session in the same CWD for the user
    c2.send({
      type: "create",
      sessionId: "s1-restored",
      cwd: meta!.cwd!,
      cols: meta!.cols,
      rows: meta!.rows,
    });
    const createResp = await c2.readLine();
    expect(createResp.type).toBe("created");
    expect(createResp.session.cwd).toBe("/project/code");

    c2.close();
    await daemon2.stop();
  });

  it("listPersistedSessions returns sessions from disk after daemon restart", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");

    const daemon1 = new E2EDaemon(tmpDir);
    await daemon1.start();

    const c = await connectRaw(daemon1.socketPath);
    c.send({ type: "auth", token: daemon1.authToken });
    await c.readLine();

    // Create 3 sessions
    for (const id of ["s1", "s2", "s3"]) {
      c.send({
        type: "create",
        sessionId: id,
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      });
      await c.readLine();
      feedSessionData(daemon1.getHost(), id, `output for ${id}`);
      flushScrollback(daemon1.getHost(), id);
    }

    c.close();
    await daemon1.stop();

    // After daemon dies, we can list persisted sessions from disk
    const persisted = ScrollbackWriter.listPersistedSessions(sessionsDir);
    expect(persisted.sort()).toEqual(["s1", "s2", "s3"]);
  });
});

describe("E2E: layout persistence + reconciliation", () => {
  let tmpDir: string;
  let layoutFile: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    layoutFile = path.join(tmpDir, "layout.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWorkspace(
    paneConfigs: Array<{
      paneId: string;
      daemonSessionId: string;
      cwd: string;
    }>,
  ): PersistedWorkspace {
    const sessions: PersistedSession[] = [];
    const paneSessions: Record<
      string,
      {
        daemonSessionId: string;
        lastCwd: string | null;
        lastTitle: string | null;
      }
    > = {};

    if (paneConfigs.length === 1) {
      const c = paneConfigs[0];
      paneSessions[c.paneId] = {
        daemonSessionId: c.daemonSessionId,
        lastCwd: c.cwd,
        lastTitle: null,
      };
      sessions.push({
        id: "tab-1",
        title: "Terminal",
        rootNode: { type: "leaf", paneId: c.paneId },
        focusedPaneId: c.paneId,
        paneSessions,
      });
    } else {
      for (const c of paneConfigs) {
        paneSessions[c.paneId] = {
          daemonSessionId: c.daemonSessionId,
          lastCwd: c.cwd,
          lastTitle: null,
        };
      }
      sessions.push({
        id: "tab-1",
        title: "Terminal",
        rootNode: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", paneId: paneConfigs[0].paneId },
          second: { type: "leaf", paneId: paneConfigs[1].paneId },
        },
        focusedPaneId: paneConfigs[0].paneId,
        paneSessions,
      });
    }

    return {
      workspacePath: "/project/main",
      sessions,
      selectedSessionId: "tab-1",
    };
  }

  it("full cycle: save layout → daemon dies → new daemon → reconcile → correct restore plan", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const layout = new LayoutPersistence(layoutFile);

    // Step 1: daemon running, two panes
    const daemon1 = new E2EDaemon(tmpDir);
    await daemon1.start();

    const c = await connectRaw(daemon1.socketPath);
    c.send({ type: "auth", token: daemon1.authToken });
    await c.readLine();

    c.send({
      type: "create",
      sessionId: "pane-A",
      cwd: "/project",
      cols: 80,
      rows: 24,
    });
    await c.readLine();
    c.send({
      type: "create",
      sessionId: "pane-B",
      cwd: "/project/sub",
      cols: 80,
      rows: 24,
    });
    await c.readLine();

    feedSessionData(daemon1.getHost(), "pane-A", "pane A output");
    feedSessionData(daemon1.getHost(), "pane-B", "pane B output");
    flushScrollback(daemon1.getHost(), "pane-A");
    flushScrollback(daemon1.getHost(), "pane-B");

    // Step 2: save layout to disk
    const workspace = makeWorkspace([
      { paneId: "pane-A", daemonSessionId: "pane-A", cwd: "/project" },
      { paneId: "pane-B", daemonSessionId: "pane-B", cwd: "/project/sub" },
    ]);
    layout.saveWorkspace(workspace);

    c.close();
    await daemon1.stop();

    // Step 3: new daemon starts (no sessions in memory)
    const daemon2 = new E2EDaemon(tmpDir);
    await daemon2.start();

    const c2 = await connectRaw(daemon2.socketPath);
    c2.send({ type: "auth", token: daemon2.authToken });
    await c2.readLine();

    c2.send({ type: "listSessions" });
    const listResp = await c2.readLine();
    expect(listResp.sessions).toHaveLength(0); // daemon2 has no sessions

    // Step 4: reconcile
    const savedLayout = layout.load()!;
    const savedWorkspace = savedLayout.workspaces[0];

    const aliveSessions = new Set(
      listResp.sessions.map((s: any) => s.sessionId),
    );
    const persistedOnDisk = new Set(
      ScrollbackWriter.listPersistedSessions(sessionsDir),
    );

    const plan = layout.reconcile(
      savedWorkspace,
      aliveSessions,
      persistedOnDisk,
    );

    // Both sessions should be "cold" (daemon lost them, but scrollback exists)
    expect(plan.actions).toHaveLength(2);
    const actionA = plan.actions.find((a) => a.paneId === "pane-A");
    const actionB = plan.actions.find((a) => a.paneId === "pane-B");
    expect(actionA?.type).toBe("cold");
    expect(actionB?.type).toBe("cold");

    if (actionA?.type === "cold") {
      expect(actionA.lastCwd).toBe("/project");
    }
    if (actionB?.type === "cold") {
      expect(actionB.lastCwd).toBe("/project/sub");
    }

    // Step 5: cold restore — read scrollback from disk
    const scrollbackA = ScrollbackWriter.readScrollback("pane-A", sessionsDir);
    expect(scrollbackA).toContain("pane A output");

    const scrollbackB = ScrollbackWriter.readScrollback("pane-B", sessionsDir);
    expect(scrollbackB).toContain("pane B output");

    c2.close();
    await daemon2.stop();
  });

  it("reconcile produces warm actions when daemon kept the session alive", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const layout = new LayoutPersistence(layoutFile);

    const daemon = new E2EDaemon(tmpDir);
    await daemon.start();

    const c = await connectRaw(daemon.socketPath);
    c.send({ type: "auth", token: daemon.authToken });
    await c.readLine();

    c.send({
      type: "create",
      sessionId: "pane-A",
      cwd: "/project",
      cols: 80,
      rows: 24,
    });
    await c.readLine();

    feedSessionData(daemon.getHost(), "pane-A", "preserved by daemon");

    // Save layout
    const workspace = makeWorkspace([
      { paneId: "pane-A", daemonSessionId: "pane-A", cwd: "/project" },
    ]);
    layout.saveWorkspace(workspace);

    // "App restart" — disconnect and reconnect, but daemon is still running
    c.close();
    await delay(50);

    const c2 = await connectRaw(daemon.socketPath);
    c2.send({ type: "auth", token: daemon.authToken });
    await c2.readLine();

    c2.send({ type: "listSessions" });
    const listResp = await c2.readLine();

    const aliveSessions = new Set(
      listResp.sessions.map((s: any) => s.sessionId),
    );
    const persistedOnDisk = new Set(
      ScrollbackWriter.listPersistedSessions(sessionsDir),
    );

    const savedLayout = layout.load()!;
    const plan = layout.reconcile(
      savedLayout.workspaces[0],
      aliveSessions,
      persistedOnDisk,
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe("warm");
    expect(plan.actions[0].paneId).toBe("pane-A");

    // Verify warm restore — snapshot has the content
    c2.send({ type: "attach", sessionId: "pane-A" });
    const attachResp = await c2.readLine();
    expect(attachResp.type).toBe("attached");
    expect(attachResp.snapshot.screenAnsi).toContain("preserved by daemon");

    c2.close();
    await daemon.stop();
  });

  it("reconcile produces mixed warm/cold/fresh for different panes", async () => {
    const sessionsDir = path.join(tmpDir, "sessions");
    const layout = new LayoutPersistence(layoutFile);

    // Create scrollback on disk for pane-B (simulate a previous daemon run)
    const writer = new ScrollbackWriter("pane-B", sessionsDir);
    writer.init({ sessionId: "pane-B", cols: 80, rows: 24, cwd: "/old" });
    writer.append("old scrollback data");
    writer.dispose();

    // Start daemon with only pane-A alive
    const daemon = new E2EDaemon(tmpDir);
    await daemon.start();

    const c = await connectRaw(daemon.socketPath);
    c.send({ type: "auth", token: daemon.authToken });
    await c.readLine();

    c.send({
      type: "create",
      sessionId: "pane-A",
      cwd: "/project",
      cols: 80,
      rows: 24,
    });
    await c.readLine();

    // Layout has 3 panes: A (daemon alive), B (scrollback on disk), C (nothing)
    const workspace: PersistedWorkspace = {
      workspacePath: "/project/main",
      sessions: [
        {
          id: "tab-1",
          title: "Terminal",
          rootNode: {
            type: "split",
            direction: "horizontal",
            ratio: 0.5,
            first: { type: "leaf", paneId: "pane-A" },
            second: {
              type: "split",
              direction: "vertical",
              ratio: 0.5,
              first: { type: "leaf", paneId: "pane-B" },
              second: { type: "leaf", paneId: "pane-C" },
            },
          },
          focusedPaneId: "pane-A",
          paneSessions: {
            "pane-A": {
              daemonSessionId: "pane-A",
              lastCwd: "/project",
              lastTitle: null,
            },
            "pane-B": {
              daemonSessionId: "pane-B",
              lastCwd: "/old",
              lastTitle: null,
            },
            "pane-C": {
              daemonSessionId: "pane-C",
              lastCwd: "/gone",
              lastTitle: null,
            },
          },
        },
      ],
      selectedSessionId: "tab-1",
    };
    layout.saveWorkspace(workspace);

    const aliveSessions = new Set(["pane-A"]); // only A alive
    const persistedOnDisk = new Set(
      ScrollbackWriter.listPersistedSessions(sessionsDir),
    );

    const plan = layout.reconcile(workspace, aliveSessions, persistedOnDisk);
    expect(plan.actions).toHaveLength(3);

    const actionA = plan.actions.find((a) => a.paneId === "pane-A");
    const actionB = plan.actions.find((a) => a.paneId === "pane-B");
    const actionC = plan.actions.find((a) => a.paneId === "pane-C");

    expect(actionA?.type).toBe("warm");
    expect(actionB?.type).toBe("cold");
    expect(actionC?.type).toBe("fresh");

    if (actionB?.type === "cold") {
      expect(actionB.lastCwd).toBe("/old");
      // Verify the cold restore scrollback is readable
      const sb = ScrollbackWriter.readScrollback("pane-B", sessionsDir);
      expect(sb).toContain("old scrollback data");
    }

    if (actionC?.type === "fresh") {
      expect(actionC.cwd).toBe("/gone");
    }

    c.close();
    await daemon.stop();
  });
});

describe("E2E: clear-scrollback escape sequence", () => {
  let tmpDir: string;
  let daemon: E2EDaemon;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    daemon = new E2EDaemon(tmpDir);
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("\\e[3J truncates scrollback.bin on disk", async () => {
    const c = await connectRaw(daemon.socketPath);
    c.send({ type: "auth", token: daemon.authToken });
    await c.readLine();

    c.send({
      type: "create",
      sessionId: "s1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    await c.readLine();

    feedSessionData(daemon.getHost(), "s1", "old stuff\r\n");
    flushScrollback(daemon.getHost(), "s1");

    const before = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(before).toContain("old stuff");

    // Send clear-scrollback
    feedSessionData(daemon.getHost(), "s1", "\x1b[3J");
    feedSessionData(daemon.getHost(), "s1", "fresh start\r\n");
    flushScrollback(daemon.getHost(), "s1");

    const after = fs.readFileSync(
      path.join(daemon.sessionsDir, "s1", "scrollback.bin"),
      "utf-8",
    );
    expect(after).not.toContain("old stuff");
    expect(after).toContain("fresh start");

    c.close();
  });
});
