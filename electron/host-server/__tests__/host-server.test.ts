/**
 * The host server end to end (ADR-218 D1, D2): `runServe` against an
 * in-process daemon (`daemon-harness.ts`) in a temp `dataDir`, reached the
 * way the owner channel reaches it — NDJSON bridge frames over
 * `server.sock`, after a hello with the owner token.
 *
 * PTY subprocesses are mocked, as in `terminal-host/e2e.test.ts`: the
 * sessions are real daemon sessions, their shells are not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough, type Duplex } from "node:stream";

import "../../terminal-host/xterm-env-polyfill";

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    return { stdin, stdout, on: vi.fn(), kill: vi.fn(), pid: 77777 };
  }),
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-host-server-zdotdir",
    setupZdotdir: () => "/tmp/manor-host-server-zdotdir",
    realZdotdir: () => "",
    bashrcPath: () => "/tmp/manor-host-server-bashrc",
  },
}));

import {
  E2EDaemon,
  delay,
  makeTmpDir,
} from "../../terminal-host/daemon-harness";
import type { HostTransport } from "../../terminal-host/transport";
import { createLineReader } from "../../terminal-host/line-reader";
import { hostServerPaths, type HostServerPaths } from "../../paths";
import type { AgentInfo } from "../../agent-persistence";
import type { PaneStatusUpdate } from "../../agent-status/effects";
import { runServe, type RunningServer } from "../serve";

/** Sockets to an already-running `E2EDaemon`; nothing is ever spawned. */
class HarnessTransport implements HostTransport {
  constructor(private readonly daemon: E2EDaemon) {}
  async ensureRunning(): Promise<void> {}
  async restart(): Promise<void> {
    throw new Error("the host server must never restart the daemon");
  }
  connectControl(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.daemon.socketPath, () =>
        resolve(socket),
      );
      socket.on("error", reject);
    });
  }
  connectStream(): Promise<Duplex> {
    return this.connectControl();
  }
  async authToken(): Promise<string> {
    return this.daemon.authToken;
  }
  async dispose(): Promise<void> {}
}

type Frame = Record<string, unknown>;

/** A bridge client on the owner socket: NDJSON frames, as `server-bridge` will pipe. */
class OwnerClient {
  readonly frames: Frame[] = [];
  private nextId = 1;
  private waiters: Array<() => void> = [];
  private constructor(private readonly socket: net.Socket) {
    socket.on(
      "data",
      createLineReader((line) => {
        this.frames.push(JSON.parse(line) as Frame);
        for (const wake of this.waiters.splice(0)) wake();
      }),
    );
  }

  static async connect(
    socketPath: string,
    token: string,
  ): Promise<OwnerClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath, () => resolve(s));
      s.on("error", reject);
    });
    const client = new OwnerClient(socket);
    client.send({ type: "hello", token });
    await client.waitFor((f) => f.type === "hello" || f.kind === "close");
    return client;
  }

  send(frame: Frame): void {
    this.socket.write(JSON.stringify(frame) + "\n");
  }

  async waitFor(
    match: (frame: Frame) => boolean,
    timeoutMs = 3_000,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(match);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Invoke `ns.method` and resolve with the whole result frame. */
  async call(
    ns: string,
    methodName: string,
    ...args: unknown[]
  ): Promise<Frame> {
    const id = this.nextId++;
    this.send({ kind: "invoke", id, ns, method: methodName, args });
    return this.waitFor((f) => f.kind === "result" && f.id === id);
  }

  /** Invoke and return the result, failing on a refusal. */
  async invoke<T>(
    ns: string,
    methodName: string,
    ...args: unknown[]
  ): Promise<T> {
    const frame = await this.call(ns, methodName, ...args);
    if (frame.ok !== true)
      throw new Error(`${ns}.${methodName}: ${String(frame.error)}`);
    return frame.result as T;
  }

  close(): void {
    this.socket.destroy();
  }
}

async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) return value;
    await delay(20);
  }
}

function hook(eventType: string, extra: Record<string, string> = {}) {
  return {
    paneId: "pane-1",
    eventType,
    kind: "claude",
    sessionId: "sess-1",
    ...extra,
  };
}

describe("host server", () => {
  let tmp: string;
  let daemon: E2EDaemon;
  let paths: HostServerPaths;
  let running: RunningServer | null = null;
  const clients: OwnerClient[] = [];

  async function serve(): Promise<RunningServer> {
    running = await runServe({
      dataDir: paths.dataDir,
      version: "1.2.3-test",
      transport: new HarnessTransport(daemon),
      logToFile: false,
    });
    await running.server.whenCaughtUp();
    return running;
  }

  async function owner(): Promise<OwnerClient> {
    const token = fs.readFileSync(paths.ownerToken, "utf-8").trim();
    const client = await OwnerClient.connect(paths.socket, token);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    tmp = makeTmpDir();
    daemon = new E2EDaemon(path.join(tmp, "daemon"));
    await daemon.start();
    paths = hostServerPaths(path.join(tmp, "server"));
    fs.mkdirSync(paths.dataDir, { recursive: true });
    // No secret-store probing in a test: plaintext was "chosen" earlier.
    fs.writeFileSync(
      paths.secretBackend,
      JSON.stringify({ backend: "plaintext" }),
    );
    // A live session for the agent's pane, so the boot sweep keeps it.
    daemon.getHost().create("pane-1", tmp, 80, 24);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await running?.stop();
    running = null;
    await daemon.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes its pid, version, 0600 owner token and socket, and removes them on stop", async () => {
    const server = await serve();
    expect(fs.readFileSync(paths.pid, "utf-8").trim()).toBe(
      String(process.pid),
    );
    expect(fs.readFileSync(paths.version, "utf-8").trim()).toBe("1.2.3-test");
    expect(fs.statSync(paths.ownerToken).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.socket).mode & 0o777).toBe(0o600);

    await server.stop();
    running = null;
    expect(fs.existsSync(paths.pid)).toBe(false);
    expect(fs.existsSync(paths.ownerToken)).toBe(false);
    expect(fs.existsSync(paths.socket)).toBe(false);
  });

  it("closes a socket whose hello has the wrong token", async () => {
    await serve();
    const client = await OwnerClient.connect(paths.socket, "not-the-token");
    clients.push(client);
    expect(client.frames).toContainEqual(
      expect.objectContaining({ kind: "close", code: 4401 }),
    );
  });

  it("serves the agents the daemon's hooks describe, live and replayed after a restart", async () => {
    await serve();
    const client = await owner();
    expect(await client.invoke<AgentInfo[]>("agents", "getAll")).toEqual([]);
    client.send({ kind: "subscribe", ns: "agents", event: "updated" });

    // Live: the hook reaches the server as a `hookEvent`.
    daemon.emitHook(hook("SessionStart"));
    daemon.emitHook(hook("UserPromptSubmit"));
    const agents = await eventually(
      () => client.invoke<AgentInfo[]>("agents", "getAll"),
      (list) => list.length === 1 && list[0].lastAgentStatus === "thinking",
    );
    expect(agents).toEqual([
      expect.objectContaining({
        agentSessionId: "sess-1",
        paneId: "pane-1",
        hostId: "local",
        status: "active",
        lastAgentStatus: "thinking",
      }),
    ]);
    await client.waitFor(
      (f) => f.kind === "event" && f.ns === "agents" && f.event === "updated",
    );
    const statuses = await client.invoke<PaneStatusUpdate[]>(
      "agents",
      "getPaneStatuses",
    );
    expect(statuses).toContainEqual(
      expect.objectContaining({ paneId: "pane-1", status: "thinking" }),
    );

    // Down: the hook only reaches the journal.
    await running!.stop();
    running = null;
    daemon.emitHook(hook("Stop"));

    // Back up: replayed from the persisted cursor, and nothing twice.
    await serve();
    const again = await owner();
    const replayed = await again.invoke<AgentInfo[]>("agents", "getAll");
    expect(replayed).toEqual([
      expect.objectContaining({
        agentSessionId: "sess-1",
        status: "active",
        lastAgentStatus: "responded",
      }),
    ]);
    await delay(600); // the cursor's debounced write
    const cursor = JSON.parse(fs.readFileSync(paths.hookCursor, "utf-8")) as {
      seq: number;
    };
    expect(cursor.seq).toBe(daemon.journal.lastSeq);
  });

  it("replays the whole journal the first time it meets it", async () => {
    // Hooks from before the server was ever installed on this box.
    daemon.emitHook(hook("SessionStart"));
    daemon.emitHook(hook("PermissionRequest"));
    await serve();
    const client = await owner();
    // The agent exists only because the replay created it. (Its last status
    // is then whatever the pane's facts say now: these mocked shells run no
    // agent process, so the resync after the catch-up settles it.)
    expect(await client.invoke<AgentInfo[]>("agents", "getAll")).toEqual([
      expect.objectContaining({
        agentSessionId: "sess-1",
        paneId: "pane-1",
        hostId: "local",
        status: "active",
      }),
    ]);
  });

  it("answers what is not on its allowlist with unavailable:host", async () => {
    await serve();
    const client = await owner();
    for (const [ns, methodName] of [
      ["projects", "add"],
      ["pty", "reset"],
      ["github", "getIssues"],
      ["layout", "apply"],
    ]) {
      const frame = await client.call(ns, methodName);
      expect(frame).toEqual(
        expect.objectContaining({ ok: false, code: "unavailable:host" }),
      );
    }
    // An empty manifest and layout until the desktop sends one (ticket 4).
    expect(await client.invoke("projects", "getAll")).toEqual([]);
    expect(await client.invoke("layout", "getAll")).toEqual({});
    expect(await client.invoke("hosts", "list")).toEqual([
      expect.objectContaining({ hostId: "local", status: "connected" }),
    ]);
  });

  it("attaches to a running session but never spawns one", async () => {
    await serve();
    const client = await owner();
    const missing = await client.invoke<Frame>(
      "pty",
      "create",
      "pane-nope",
      null,
      80,
      24,
    );
    expect(missing).toEqual(
      expect.objectContaining({ ok: false, reason: "error" }),
    );
    expect(
      daemon
        .getHost()
        .listSessions()
        .map((s) => s.sessionId),
    ).toEqual(["pane-1"]);

    const attached = await client.invoke<Frame>(
      "pty",
      "create",
      "pane-1",
      null,
      80,
      24,
    );
    expect(attached).toEqual(
      expect.objectContaining({ ok: true, hostId: "local" }),
    );
  });
});
