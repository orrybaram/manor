/**
 * The host server end to end (ADR-218 D1, D2): `runServe` against an
 * in-process daemon (`daemon-harness.ts`) in a temp `dataDir`, reached the
 * way the owner channel reaches it — NDJSON bridge frames over
 * `server.sock`, after a hello with the owner token.
 *
 * PTY subprocesses are mocked, as in `terminal-host/e2e.test.ts`: the
 * sessions are real daemon sessions, their shells are not.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { execFile } from "node:child_process";

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
import { hostLayoutSnapshot } from "../owner";
import { ownerTokenAuthenticator } from "../socket";
import type { HostManifest } from "../manifest";
import type { HostLayoutSnapshot } from "../layout";
import type { ProjectInfo } from "../../projects/types";
import type { LayoutEntry } from "../../../src/lib/layout/protocol";
import type { HostServerStatus } from "../relay";
import type { PairResult } from "../../remote-control/controller";
import type { RemoteDeviceInfo } from "../../remote-control/devices";
import {
  FakeRelay,
  FakeViewer,
} from "../../remote-control/relay/__tests__/fake-relay";
import { base64urlDecode } from "../../../src/lib/relay-crypto";
import { WebSocket as WsWebSocket, type ClientOptions } from "ws";

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

/** What a pairing link carries in its fragment. */
function parsePairingUrl(url: string): {
  base: string;
  roomId: string;
  x25519Pub: string;
  token: string;
} {
  const match = /^(.*)#relay=([^.]+)\.([^&]+)&t=(.+)$/.exec(url);
  if (!match) throw new Error(`not a pairing link: ${url}`);
  return {
    base: match[1],
    roomId: match[2],
    x25519Pub: match[3],
    token: match[4],
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await delay(10);
  }
}

type PushCall = { endpoint: string; payload: unknown };

describe("host server", () => {
  let tmp: string;
  let daemon: E2EDaemon;
  let paths: HostServerPaths;
  let running: RunningServer | null = null;
  let relay: FakeRelay;
  let pushes: PushCall[];
  let socketsMade: number;
  const clients: OwnerClient[] = [];
  const viewers: FakeViewer[] = [];

  /** `ws`'s WebSocket, counted: what the server passes the connector. */
  class CountingWebSocket extends WsWebSocket {
    constructor(url: string, options: ClientOptions) {
      super(url, options);
      socketsMade += 1;
    }
  }

  async function serve(): Promise<RunningServer> {
    running = await runServe({
      dataDir: paths.dataDir,
      version: "1.2.3-test",
      transport: new HarnessTransport(daemon),
      logToFile: false,
      relay: {
        relayUrl: relay.url,
        webSocket: CountingWebSocket,
        timing: { backoffMinMs: 20, backoffMaxMs: 100 },
        pushSend: async (subscription, payload) => {
          pushes.push({
            endpoint: subscription.endpoint,
            payload: JSON.parse(String(payload)),
          });
          return { statusCode: 201, body: "", headers: {} };
        },
        pushGenerate: () => ({ publicKey: "vapid-pub", privateKey: "vapid" }),
      },
    });
    await running.server.whenCaughtUp();
    return running;
  }

  /** Wait for the server's relay connector to hold its room. */
  async function relayUp(server: RunningServer): Promise<void> {
    await until(
      () => server.server.relay.relayStatus().connected,
      "relay connected",
    );
  }

  /** A phone: through the relay to the room in `pairingUrl`, hello'd. */
  async function phone(pairingUrl: string): Promise<{
    viewer: FakeViewer;
    call(ns: string, method: string, ...args: unknown[]): Promise<Frame>;
  }> {
    const link = parsePairingUrl(pairingUrl);
    const viewer = await FakeViewer.open(
      relay.url,
      link.roomId,
      base64urlDecode(link.x25519Pub),
    );
    viewers.push(viewer);
    viewer.send({ type: "hello", token: link.token });
    const hello = await viewer.next((f) => f.type === "hello");
    expect(hello).toMatchObject({ ok: true });
    let nextId = 1;
    return {
      viewer,
      async call(ns, methodName, ...args) {
        const id = nextId++;
        viewer.send({ kind: "invoke", id, ns, method: methodName, args });
        return viewer.next((f) => f.kind === "result" && f.id === id);
      },
    };
  }

  async function owner(): Promise<OwnerClient> {
    const token = fs.readFileSync(paths.ownerToken, "utf-8").trim();
    const client = await OwnerClient.connect(paths.socket, token);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    relay = new FakeRelay();
    await relay.listen();
    pushes = [];
    socketsMade = 0;
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
    for (const viewer of viewers.splice(0)) viewer.ws.terminate();
    await running?.stop();
    running = null;
    await daemon.stop();
    await relay.close();
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
      // No integration calls in slice 1 (ADR-218 D8), issue images included.
      ["github", "getPrsForBranches"],
      ["github", "proxyImage"],
      ["linear", "getAllIssues"],
      ["linear", "proxyImage"],
    ]) {
      const frame = await client.call(ns, methodName);
      expect(frame).toEqual(
        expect.objectContaining({ ok: false, code: "unavailable:host" }),
      );
    }
    // An empty manifest and layout until the desktop sends one.
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
  describe("its own relay room (ADR-218 D3)", () => {
    it("dials its room through the injected WebSocket constructor", async () => {
      const server = await serve();
      await relayUp(server);
      expect(socketsMade).toBeGreaterThanOrEqual(1);
      const { roomId } = server.server.relay.relayStatus();
      expect(relay.liveHost?.roomId).toBe(roomId);
    });

    it("pairs a phone with a link to the room derived from its identity", async () => {
      const server = await serve();
      const client = await owner();
      const status = await client.invoke<HostServerStatus>(
        "hostServer",
        "status",
      );
      expect(status).toMatchObject({
        version: "1.2.3-test",
        secretBackend: "plaintext",
        devices: 0,
        pushEndpoints: [],
      });
      expect(status.relay.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);

      const paired = await client.invoke<PairResult>(
        "remoteControl",
        "pair",
        "phone",
      );
      const link = parsePairingUrl(paired.pairingUrl);
      const origin = relay.url.replace("ws://", "http://");
      expect(link.base).toBe(`${origin}/app/1.2.3-test/`);
      expect(link.roomId).toBe(status.relay.roomId);
      expect(link.token).toBe(paired.rawToken);
      expect(paired.device).toMatchObject({ label: "phone", hasPush: false });

      const devices = await client.invoke<RemoteDeviceInfo[]>(
        "remoteControl",
        "listDevices",
      );
      expect(devices.map((d) => d.id)).toEqual([paired.device.id]);

      // The phone reaches this server's bridge through the room, as a device.
      await relayUp(server);
      const p = await phone(paired.pairingUrl);
      const agents = await p.call("agents", "getAll");
      expect(agents).toMatchObject({ ok: true, result: [] });
    });

    it("refuses a device the owner's methods", async () => {
      const server = await serve();
      await relayUp(server);
      const client = await owner();
      const paired = await client.invoke<PairResult>(
        "remoteControl",
        "pair",
        "phone",
      );
      const p = await phone(paired.pairingUrl);
      for (const [ns, methodName, ...args] of [
        ["remoteControl", "pair", "another"],
        ["remoteControl", "listDevices"],
        ["remoteControl", "revoke", paired.device.id],
        ["hostServer", "status"],
        ["hostServer", "resetIdentity"],
        ["hostServer", "syncManifest", { version: 1 }],
        ["hostServer", "syncLayout", { version: 1 }],
      ] as Array<[string, string, ...unknown[]]>) {
        expect(await p.call(ns, methodName, ...args)).toMatchObject({
          ok: false,
          code: "unavailable:host",
        });
      }
      // Nothing changed hands.
      expect(
        await client.invoke<RemoteDeviceInfo[]>("remoteControl", "listDevices"),
      ).toHaveLength(1);
    });

    it("revokes a device and closes its channel", async () => {
      const server = await serve();
      await relayUp(server);
      const client = await owner();
      const paired = await client.invoke<PairResult>(
        "remoteControl",
        "pair",
        "phone",
      );
      const p = await phone(paired.pairingUrl);
      expect(
        await client.invoke("remoteControl", "revoke", paired.device.id),
      ).toEqual([]);
      await until(
        () =>
          p.viewer.frames.some((f) => f.kind === "close") ||
          p.viewer.ws.readyState >= WsWebSocket.CLOSING,
        "revoked channel closed",
      );
    });

    it("pushes a requires_input transition to a subscribed phone", async () => {
      const server = await serve();
      await relayUp(server);
      const client = await owner();
      const paired = await client.invoke<PairResult>(
        "remoteControl",
        "pair",
        "phone",
      );
      const p = await phone(paired.pairingUrl);
      expect(await p.call("remoteControl", "vapidPublicKey")).toMatchObject({
        ok: true,
        result: "vapid-pub",
      });
      const subscription = {
        endpoint: "https://push.example/endpoint-1",
        keys: { p256dh: "p256", auth: "auth" },
      };
      expect(
        await p.call("remoteControl", "subscribePush", subscription),
      ).toMatchObject({ ok: true, result: true });
      // The owner can't subscribe: there is no device behind it.
      expect(
        await client.call("remoteControl", "subscribePush", subscription),
      ).toMatchObject({ ok: false });

      expect(
        (await client.invoke<HostServerStatus>("hostServer", "status"))
          .pushEndpoints,
      ).toEqual(["https://push.example/endpoint-1"]);

      daemon.emitHook(hook("SessionStart"));
      daemon.emitHook(hook("UserPromptSubmit"));
      daemon.emitHook(hook("PermissionRequest"));
      await until(() => pushes.length > 0, "a push");
      expect(pushes).toEqual([
        {
          endpoint: "https://push.example/endpoint-1",
          payload: expect.objectContaining({ title: "Agent needs input" }),
        },
      ]);
    });

    it("resetIdentity moves to a new room and revokes every device", async () => {
      const server = await serve();
      await relayUp(server);
      const client = await owner();
      const before = await client.invoke<HostServerStatus>(
        "hostServer",
        "status",
      );
      const paired = await client.invoke<PairResult>(
        "remoteControl",
        "pair",
        "phone",
      );
      const p = await phone(paired.pairingUrl);
      await p.call("remoteControl", "subscribePush", {
        endpoint: "https://push.example/endpoint-1",
        keys: { p256dh: "p256", auth: "auth" },
      });

      const after = await client.invoke<HostServerStatus>(
        "hostServer",
        "resetIdentity",
      );
      expect(after.relay.roomId).not.toBe(before.relay.roomId);
      expect(after.devices).toBe(0);
      expect(after.pushEndpoints).toEqual([]);
      expect(await client.invoke("remoteControl", "listDevices")).toEqual([]);

      // The connector holds the new room.
      await until(
        () => relay.liveHost?.roomId === after.relay.roomId,
        "connector on the new room",
      );
      // The old link is dead: its token no longer passes the hello.
      const relink = await client.invoke<PairResult>(
        "remoteControl",
        "pair",
        "phone-2",
      );
      expect(parsePairingUrl(relink.pairingUrl).roomId).toBe(
        after.relay.roomId,
      );

      // And it survives a restart: the identity was persisted.
      await server.stop();
      running = null;
      const again = await serve();
      expect(again.server.relay.relayStatus().roomId).toBe(after.relay.roomId);
    });
  });
  describe("the owner channel (ADR-218 D4)", () => {
    function manifest(projectPath: string): HostManifest {
      return {
        version: 1,
        sentAt: "2026-10-12T10:00:00.000Z",
        projects: [
          {
            id: "proj-1",
            name: "Manor",
            path: projectPath,
            hostId: "local",
            selectedWorkspaceIndex: 0,
            workspaces: [],
            defaultBranch: "main",
            defaultRunCommand: null,
            worktreePath: null,
            color: "#f00",
            workspaceNames: { [projectPath]: "Main checkout" },
            workspaceIssues: {
              [projectPath]: [
                { id: "i-1", identifier: "ENG-1", title: "Fix it", url: "https://linear.app/i-1" },
              ],
            },
          },
        ],
        integrationSnapshot: {
          [projectPath]: {
            takenAt: "2026-10-12T09:59:00.000Z",
            issue: { id: "i-1", title: "Fix it", url: "https://linear.app/i-1" },
            pr: { number: 7, state: "open", title: "Fix it", url: "https://github.com/o/r/pull/7" },
          },
        },
      };
    }

    function entry(version: number, paneId: string): LayoutEntry {
      return {
        version,
        layout: { panelTree: { type: "leaf", panelId: "p" }, panels: {} } as never,
        defaultViewport: {} as never,
        paneSessions: { [paneId]: { sessionId: paneId } as never },
        claims: [{ windowId: "w", tabId: "t" } as never],
      };
    }

    it("authenticates the owner hello as an owner, and only with role owner", () => {
      const auth = ownerTokenAuthenticator("tok");
      expect(auth("tok", { type: "hello", token: "tok", role: "owner" })).toEqual({
        ok: true,
        caller: "owner",
      });
      expect(auth("tok", { type: "hello", token: "tok" })).toEqual({
        ok: true,
        caller: "owner",
      });
      expect(auth("tok", { type: "hello", token: "tok", role: "device" })).toMatchObject({
        ok: false,
        code: 4401,
      });
      expect(auth("nope", { type: "hello", token: "nope" })).toMatchObject({ ok: false });
    });

    it("persists a synced manifest, serves it, and tells a subscribed phone", async () => {
      // There is no git in this test: every worktree listing fails at once,
      // so a project shows its main checkout, as on a box without the repo.
      vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error) => void;
        setImmediate(() =>
          callback(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })),
        );
        return {};
      }) as never);
      onTestFinished(() => {
        vi.mocked(execFile).mockReset();
      });
      const server = await serve();
      await relayUp(server);
      const client = await owner();
      const paired = await client.invoke<PairResult>("remoteControl", "pair", "phone");
      const p = await phone(paired.pairingUrl);
      p.viewer.send({ kind: "subscribe", ns: "projects", event: "changed" });
      // The subscribe has no reply; a round trip makes sure it landed.
      await p.call("agents", "getAll");

      expect(await client.invoke("hostServer", "syncManifest", manifest(tmp))).toBe(true);

      const onDisk = JSON.parse(fs.readFileSync(paths.manifest, "utf-8")) as HostManifest;
      expect(onDisk).toEqual(manifest(tmp));
      expect(fs.statSync(paths.manifest).mode & 0o777).toBe(0o600);
      // No temp file left behind by the atomic write.
      expect(fs.readdirSync(paths.dataDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

      await p.viewer.next((f) => f.kind === "event" && f.ns === "projects" && f.event === "changed");

      const projects = await p.call("projects", "getAll");
      expect(projects).toMatchObject({ ok: true });
      const list = projects.result as ProjectInfo[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: "proj-1", name: "Manor", hostId: "local", color: "#f00" });
      expect(list[0].workspaces[0]).toMatchObject({
        path: tmp,
        name: "Main checkout",
        linkedIssues: [expect.objectContaining({ identifier: "ENG-1" })],
      });
    });

    it("rewrites only this host's layout keys to bare paths, and serves the snapshot", async () => {
      const snapshot = hostLayoutSnapshot(
        {
          "box:/home/me/a": entry(3, "pane-a"),
          "box:/home/me/b": entry(1, "pane-b"),
          "other:/home/me/a": entry(9, "pane-x"),
          "/Users/me/local": entry(2, "pane-l"),
        },
        "box:/home/me/b",
        "box",
        "2026-10-12T10:00:00.000Z",
      );
      expect(Object.keys(snapshot.workspaces).sort()).toEqual(["/home/me/a", "/home/me/b"]);
      expect(snapshot.workspaces["/home/me/a"].version).toBe(3);
      expect(snapshot.workspaces["/home/me/a"].claims).toEqual([]);
      expect(snapshot.lastActiveWorkspacePath).toBe("/home/me/b");
      // Last active on another host is not this host's to show.
      expect(
        hostLayoutSnapshot({}, "other:/home/me/a", "box", "t").lastActiveWorkspacePath,
      ).toBeNull();

      const server = await serve();
      await relayUp(server);
      const client = await owner();
      const paired = await client.invoke<PairResult>("remoteControl", "pair", "phone");
      const p = await phone(paired.pairingUrl);
      p.viewer.send({ kind: "subscribe", ns: "layout", event: "changed" });
      await p.call("agents", "getAll");

      expect(await client.invoke("hostServer", "syncLayout", snapshot)).toBe(true);
      expect(
        (JSON.parse(fs.readFileSync(paths.layout, "utf-8")) as HostLayoutSnapshot).workspaces,
      ).toEqual(snapshot.workspaces);
      expect(await p.call("layout", "getAll")).toMatchObject({
        ok: true,
        result: snapshot.workspaces,
      });
      expect(await p.call("layout", "getLastActive")).toMatchObject({
        ok: true,
        result: "/home/me/b",
      });
      const changed = await p.viewer.next(
        (f) =>
          f.kind === "event" &&
          f.ns === "layout" &&
          (f.args as Array<{ workspacePath: string }>)[0].workspacePath === "/home/me/a",
      );
      expect((changed.args as LayoutEntry[])[0]).toMatchObject({ version: 3, claims: [] });

      // A workspace dropped from the next snapshot is announced removed.
      const { ["/home/me/b"]: _dropped, ...rest } = snapshot.workspaces;
      await client.invoke("hostServer", "syncLayout", {
        ...snapshot,
        workspaces: rest,
        lastActiveWorkspacePath: null,
      });
      await p.viewer.next(
        (f) =>
          f.kind === "event" &&
          f.ns === "layout" &&
          (f.args as Array<{ workspacePath: string; removed?: boolean }>)[0].workspacePath ===
            "/home/me/b" &&
          (f.args as Array<{ removed?: boolean }>)[0].removed === true,
      );
    });

    it("refuses a malformed manifest or layout and keeps what it had", async () => {
      await serve();
      const client = await owner();
      await client.invoke("hostServer", "syncManifest", manifest(tmp));
      const before = fs.readFileSync(paths.manifest, "utf-8");

      const bad: unknown[] = [
        null,
        { ...manifest(tmp), version: 2 },
        // Not rewritten to local.
        { ...manifest(tmp), projects: [{ ...manifest(tmp).projects[0], hostId: "box" }] },
        { ...manifest(tmp), projects: [{ ...manifest(tmp).projects[0], path: "relative" }] },
        { ...manifest(tmp), integrationSnapshot: { [tmp]: { takenAt: 1, issue: null, pr: null } } },
        { ...manifest(tmp), projects: [{ ...manifest(tmp).projects[0], workspaceNames: { a: 1 } }] },
      ];
      for (const payload of bad) {
        expect(await client.call("hostServer", "syncManifest", payload)).toMatchObject({
          ok: false,
          code: "failed",
        });
      }
      expect(fs.readFileSync(paths.manifest, "utf-8")).toBe(before);

      const good = hostLayoutSnapshot({ "box:/a": entry(1, "p") }, null, "box", "t");
      for (const payload of [
        { ...good, version: 9 },
        // A host-qualified key was not rewritten.
        { ...good, workspaces: { "box:/a": good.workspaces["/a"] } },
        { ...good, workspaces: { "/a": { version: 1 } } },
        { ...good, lastActiveWorkspacePath: "box:/a" },
      ]) {
        expect(await client.call("hostServer", "syncLayout", payload)).toMatchObject({
          ok: false,
          code: "failed",
        });
      }
      expect(fs.existsSync(paths.layout)).toBe(false);
      expect(await client.invoke("layout", "getAll")).toEqual({});
    });
  });
});
