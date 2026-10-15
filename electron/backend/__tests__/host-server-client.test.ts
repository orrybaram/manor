/**
 * The desktop's end of the owner channel (ADR-225 D4): `HostServerClient`
 * against a real host server in this process, reached exactly as over ssh —
 * `runServerBridge` (what `manor-host server-bridge` runs) on in-memory
 * stdio, piping to the server's unix socket — but with no ssh and no daemon.
 * And the records the desktop will hand it on adoption (ADR-227 D3), from
 * memory only.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHostServer, type HostServer } from "../../host-server/server";
import {
  listenHostSocket,
  newOwnerToken,
  ownerTokenAuthenticator,
  writeOwnerToken,
  type HostSocketListener,
} from "../../host-server/socket";
import type { HostRelay } from "../../host-server/relay";
import type { OwnershipState } from "../../host-server/ownership";
import { hostServerPaths, type HostServerPaths } from "../../paths";
import { plainFileSecretBox } from "../../platform/secret-box";
import type { HostTransport } from "../../terminal-host/transport";
import { runServerBridge } from "../../terminal-host/server-bridge";
import { readPastServerHello } from "../../host-server/__tests__/hello-stream";
import {
  HostServerClient,
  HostServerUnavailableError,
  type HostServerClientOptions,
} from "../host-server-client";
import { HostServerSync, layoutSnapshotFor, serverFactsOf } from "../host-server-sync";
import { BackendRegistry } from "../registry";
import type { HostProvider } from "../providers/types";
import type { HostConnectionEvent, RemoteHostBackend, StreamEvent } from "../types";
import { ProjectManager } from "../../projects/project-manager";
import type { PersistedProject } from "../../projects/types";
import type { LayoutEntry } from "../../../src/lib/layout/protocol";
import type { ProjectInfo } from "../../projects/types";
import { createTab } from "../../../src/lib/layout/ids";

/** One `Duplex` writing to `writable` and reading from `readable`. */
function joined(writable: NodeJS.WritableStream, readable: NodeJS.ReadableStream): Duplex {
  return Duplex.from({ writable, readable } as unknown as Parameters<typeof Duplex.from>[0]);
}

/** A daemon that is never there: the owner channel does not need one. */
const noDaemon: HostTransport = {
  ensureRunning: async () => {},
  restart: async () => {},
  connectControl: () => Promise.reject(new Error("no daemon in this test")),
  connectStream: () => Promise.reject(new Error("no daemon in this test")),
  authToken: async () => "",
  dispose: async () => {},
};

/**
 * One owner stream, as `SshTransport.openServerBridge` would give it:
 * `runServerBridge` on in-memory stdio, read past the server's hello reply.
 * When the bridge cannot reach a server it rejects before writing anything;
 * the open then fails, as an ssh child exiting non-zero does.
 */
async function bridgeStream(paths: HostServerPaths): Promise<Duplex> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // The server is already running in-process; never spawn a real one.
  runServerBridge(
    { stdin, stdout, stderr },
    { paths, ensureServerRunning: async () => {} },
  ).catch((err: Error) => {
    stdout.destroy(err);
  });
  await readPastServerHello(stdout);
  return joined(stdin, stdout);
}

function entry(version: number): LayoutEntry {
  return {
    version,
    layout: {} as never,
    defaultViewport: {} as never,
    paneSessions: {},
    claims: [],
  };
}

const quiet = { info: vi.fn(), warn: vi.fn() };

describe("HostServerClient over server-bridge", () => {
  let tmp: string;
  let paths: HostServerPaths;
  let server: HostServer;
  let ownership: OwnershipState;
  let listener: HostSocketListener | null;
  const clients: HostServerClient[] = [];

  async function listen(): Promise<void> {
    const token = newOwnerToken();
    writeOwnerToken(paths.ownerToken, token);
    listener = await listenHostSocket(
      paths.socket,
      server.frames,
      ownerTokenAuthenticator(token),
    );
  }

  async function unlisten(): Promise<void> {
    await listener?.close();
    listener = null;
    fs.rmSync(paths.ownerToken, { force: true });
  }

  function client(opts: Partial<HostServerClientOptions> = {}): HostServerClient {
    const c = new HostServerClient({
      hostId: "box",
      open: () => bridgeStream(paths),
      requestTimeoutMs: 2_000,
      retryDelayMs: () => 20,
      log: quiet,
      ...opts,
    });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    quiet.info.mockClear();
    quiet.warn.mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manor-hsc-"));
    paths = hostServerPaths(path.join(tmp, "server"));
    let relay!: HostRelay;
    server = createHostServer({
      dataDir: paths.dataDir,
      secretBox: plainFileSecretBox,
      appVersion: "9.9.9-test",
      transport: noDaemon,
      internals: (parts) => {
        relay = parts.relay;
        ownership = parts.ownership;
      },
    });
    // Its identity and device stores, without dialling the relay.
    await relay.init();
    await listen();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.dispose();
    await unlisten();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("connects as the owner, asks for status, and sets up a project once the host is adopted", async () => {
    const c = client();
    const states: string[] = [];
    c.onStateChange((state) => states.push(state));
    c.hostConnected();
    await vi.waitFor(() => expect(c.state).toBe("connected"));
    expect(states).toEqual(["connecting", "connected"]);

    const status = await c.api.hostServer.status();
    expect(status).toMatchObject({
      version: "9.9.9-test",
      ownership: "pending",
      devices: 0,
      pushEndpoints: [],
    });
    expect(await c.api.remoteControl.listDevices()).toEqual([]);

    // Not adopted yet (ADR-227 D3): no projects, and a write is a stated
    // refusal, not an error and not a dropped channel.
    expect(await c.api.projects.getAll()).toEqual([]);
    await expect(c.api.projects.add("Manor", tmp)).rejects.toMatchObject({
      name: "HostServerUnavailableError",
      message: expect.stringMatching(/being set up/),
    });
    expect(c.state).toBe("connected");

    // Adopted: the owner adds a project, and the server's own layout store
    // persists to `layout.json` (ADR-227 D2).
    ownership.set("host");
    expect((await c.api.hostServer.status()).ownership).toBe("host");
    expect(JSON.parse(fs.readFileSync(paths.ownership, "utf-8"))).toEqual({ ownership: "host" });
    const project = (await c.api.projects.add("Manor", tmp)) as ProjectInfo;
    expect(project).toMatchObject({ name: "Manor", path: tmp, hostId: "local" });
    expect(JSON.parse(fs.readFileSync(paths.projects, "utf-8")).projects[0].path).toBe(tmp);

    await c.api.layout.apply(tmp, { type: "new-tab", tab: createTab(undefined, "pane-a") });
    await vi.waitFor(() => {
      const file = JSON.parse(fs.readFileSync(paths.layout, "utf-8")) as {
        workspaces: Array<{ workspacePath: string }>;
      };
      // Keyed by the bare path: to the host server its own host is local.
      expect(file.workspaces.map((ws) => ws.workspacePath)).toEqual([tmp]);
    });
  });

  it("is unsupported, quietly and once, on a box with no host server, until the host reconnects", async () => {
    await unlisten();
    const c = client();
    c.hostConnected();
    await vi.waitFor(() => expect(c.state).toBe("unsupported"));
    expect(await c.connect()).toBe(false);
    await expect(c.api.hostServer.status()).rejects.toBeInstanceOf(HostServerUnavailableError);
    expect(quiet.info).toHaveBeenCalledTimes(1);
    expect(String(quiet.info.mock.calls[0][0])).toMatch(/no host server/);
    expect(quiet.warn).not.toHaveBeenCalled();

    // The host reconnects (bootstrap may have installed one): try again.
    await listen();
    c.hostLost();
    c.hostConnected();
    await vi.waitFor(() => expect(c.state).toBe("connected"));
  });

  it("is unsupported when the provider has no server channel", async () => {
    const c = client({ open: null });
    c.hostConnected();
    expect(c.state).toBe("unsupported");
    expect(quiet.info).toHaveBeenCalledTimes(1);
  });

  it("answers a device-only refusal as unavailable, not as a dropped channel", async () => {
    const c = client();
    c.hostConnected();
    await vi.waitFor(() => expect(c.state).toBe("connected"));
    // Not on the host table at all: `unavailable:host`.
    const missing = (c.api as unknown as Record<string, Record<string, () => Promise<unknown>>>)
      .agents.launch();
    await expect(missing).rejects.toMatchObject({
      name: "HostServerUnavailableError",
      state: "refused",
    });
    expect(c.state).toBe("connected");
  });

  it("re-sends the VAPID pair after every connect, and redials a dropped channel", async () => {
    const c = client();
    const connected = vi.fn();
    c.onStateChange((state) => {
      if (state === "connected") connected();
    });
    const vapidKeys = vi.fn(async () => ({ publicKey: "desktop-pub", privateKey: "desktop-priv" }));
    const sync = new HostServerSync({
      // The registry's part: every state change of the one host's channel.
      registry: {
        hostServer: () => c,
        hostServers: () => [c],
        onHostServerStateChange: (listener) =>
          c.onStateChange((state) => listener("box", state)),
      },
      vapidKeys,
      log: quiet,
    });
    sync.start();

    c.hostConnected();
    await vi.waitFor(() => expect(fs.existsSync(paths.vapid)).toBe(true));
    expect(vapidKeys).toHaveBeenCalledTimes(1);
    // Neither projects nor layout are pushed: the host server owns them.
    expect(fs.existsSync(paths.projects)).toBe(false);

    // The host reconnects: the key is sent again.
    c.hostLost();
    expect(c.state).toBe("idle");
    c.hostConnected();
    await vi.waitFor(() => expect(vapidKeys).toHaveBeenCalledTimes(2));
    expect(connected).toHaveBeenCalledTimes(2);

    // The server restarts under a connected host: the channel is redialled
    // (not marked unsupported) and the key is sent again.
    await unlisten();
    await vi.waitFor(() => expect(c.state).not.toBe("connected"));
    await listen();
    await vi.waitFor(() => expect(c.state).toBe("connected"));
    await vi.waitFor(() => expect(vapidKeys).toHaveBeenCalledTimes(3));
    expect(connected).toHaveBeenCalledTimes(3);
    sync.dispose();
  });

  it("records the host's room and viewer-bridge capability from its status (ADR-228)", async () => {
    const c = client();
    const setServerFacts = vi.fn();
    const sync = new HostServerSync({
      registry: {
        hostServer: () => c,
        hostServers: () => [c],
        onHostServerStateChange: (listener) =>
          c.onStateChange((state) => listener("box", state)),
        setServerFacts,
      },
      log: quiet,
    });
    sync.start();
    c.hostConnected();
    await vi.waitFor(() => expect(setServerFacts).toHaveBeenCalled());
    const status = await c.api.hostServer.status();
    // It says it takes viewer streams, but not before it is adopted.
    expect(status.capabilities).toContain("viewer-bridge");
    expect(status.ownership).toBe("pending");
    // A current server also says whether it is busy and which box hooks it has (ADR-229 D7).
    expect(setServerFacts).toHaveBeenLastCalledWith("box", {
      roomId: status.relay.roomId,
      viewerBridge: false,
      busy: false,
      hooks: { onBusy: false, onIdle: false },
    });
    expect(status.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    sync.dispose();
  });

  it("installs supervision on connect where the record wants it and the host has none (ADR-229 D4)", async () => {
    const c = client();
    const install = vi.fn(async () => {});
    const wanted = vi.fn((hostId: string) => hostId === "box");
    const sync = new HostServerSync({
      registry: {
        hostServer: () => c,
        hostServers: () => [c],
        onHostServerStateChange: (listener) =>
          c.onStateChange((state) => listener("box", state)),
      },
      supervision: { wanted, install },
      log: quiet,
    });
    sync.start();
    c.hostConnected();
    await vi.waitFor(() => expect(install).toHaveBeenCalledWith("box"));
    // Nothing supervises the test box: its status says so.
    expect((await c.api.hostServer.status()).supervisor).toBeNull();
    sync.dispose();
  });

  it("leaves a host whose record does not want supervision alone", async () => {
    const c = client();
    const install = vi.fn(async () => {});
    const wanted = vi.fn(() => false);
    const setServerFacts = vi.fn();
    const sync = new HostServerSync({
      registry: {
        hostServer: () => c,
        hostServers: () => [c],
        onHostServerStateChange: (listener) =>
          c.onStateChange((state) => listener("box", state)),
        setServerFacts,
      },
      supervision: { wanted, install },
      log: quiet,
    });
    sync.start();
    c.hostConnected();
    // Asked once the rest of the connect's sync is done; nothing installed.
    await vi.waitFor(() => expect(wanted).toHaveBeenCalledWith("box"));
    expect(setServerFacts).toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("says the viewer hello for `server-bridge --viewer`, and the owner's otherwise", async () => {
    const sock = path.join(tmp, "probe.sock");
    const hellos: unknown[] = [];
    const probe = net.createServer((s) => {
      s.once("data", (chunk) => {
        hellos.push(JSON.parse(chunk.toString("utf-8").split("\n")[0]));
        s.end();
      });
    });
    await new Promise<void>((resolve) => probe.listen(sock, resolve));
    const run = (viewer: boolean) =>
      runServerBridge(
        { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
        {
          paths: { socket: sock, ownerToken: paths.ownerToken },
          ensureServerRunning: async () => {},
          viewer,
        },
      );
    try {
      await run(true);
      await run(false);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    const token = fs.readFileSync(paths.ownerToken, "utf-8").trim();
    expect(hellos).toEqual([
      { type: "hello", token, viewer: "desktop" },
      { type: "hello", token },
    ]);
  });
});

describe("serverFactsOf (ADR-228)", () => {
  it("reads an older host's status as no viewer bridge, with its relay's room", () => {
    const relay = { roomId: "room-1", connected: true, error: null };
    expect(serverFactsOf({ relay })).toEqual({ roomId: "room-1", viewerBridge: false });
    expect(serverFactsOf({ relay, capabilities: ["other"] })).toMatchObject({
      viewerBridge: false,
    });
    expect(
      serverFactsOf({ relay, roomId: "room-1", capabilities: ["viewer-bridge"] }),
    ).toEqual({ roomId: "room-1", viewerBridge: true });
  });

  it("says no viewer bridge until the host is adopted", () => {
    const relay = { roomId: "room-1", connected: true, error: null };
    const status = { relay, capabilities: ["viewer-bridge"] };
    expect(serverFactsOf({ ...status, ownership: "pending" }).viewerBridge).toBe(false);
    expect(serverFactsOf({ ...status, ownership: "host" }).viewerBridge).toBe(true);
  });
});

describe("BackendRegistry's owner channels", () => {
  /** Just enough of a remote backend for `RemoteHostConnection`. */
  function fakeRemote() {
    const hostHandlers: Array<(event: HostConnectionEvent) => void> = [];
    const backend = {
      pty: {
        onEvent: (_h: (event: StreamEvent) => void) => () => {},
        listSessions: async () => [],
      },
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      onHostEvent: (handler: (event: HostConnectionEvent) => void) => {
        hostHandlers.push(handler);
        return () => {};
      },
      retryNow: () => false,
      checkLiveness: async () => true,
    };
    return {
      backend: backend as unknown as RemoteHostBackend,
      hostEvent: (event: HostConnectionEvent) => {
        for (const h of hostHandlers) h(event);
      },
    };
  }

  it("dials on connect, lets go on a drop, and re-syncs on every reconnect", async () => {
    const remote = fakeRemote();
    const openServerChannel = vi.fn(() => Promise.reject(new Error("exit 3")));
    const registry = new BackendRegistry({
      local: fakeRemote().backend,
      remoteVersion: "0.0.1",
      createProvider: () =>
        ({
          kind: "ssh",
          capabilities: { canStop: false, canDestroy: false, autoSleep: false },
          ensureUp: async () => {},
          status: async () => ({ state: "up" }),
          transport: () => {
            throw new Error("unused");
          },
          forwardPort: vi.fn(),
          dispose: async () => {},
          openServerChannel,
        }) as unknown as HostProvider,
      createRemote: () => remote.backend,
      hostServerClient: { log: quiet },
    });
    registry.register("box", { kind: "ssh", target: "me@box" });
    const client = registry.hostServer("box")!;
    expect(client.state).toBe("idle");
    expect(registry.hostServer("local")).toBeUndefined();

    await registry.ensureConnected("box");
    await vi.waitFor(() => expect(client.state).toBe("unsupported"));
    expect(openServerChannel).toHaveBeenCalledTimes(1);

    // The host drops and comes back: unsupported is forgotten, it dials again.
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 10 });
    expect(client.state).toBe("idle");
    remote.hostEvent({ type: "hostReconnected", sessionIds: [] });
    await vi.waitFor(() => expect(openServerChannel).toHaveBeenCalledTimes(2));

    // The host is replaced: its channel goes with the old connection.
    registry.register("box", { kind: "ssh", target: "me@box2" });
    expect(registry.hostServer("box")).not.toBe(client);
    expect(registry.hostServers()).toEqual([registry.hostServer("box")]);
    await vi.waitFor(() => expect(client.state).toBe("idle"));
    expect(await client.connect()).toBe(false);

    await registry.unregister("box");
    expect(registry.hostServer("box")).toBeUndefined();
  });

  it("lists a host's server facts once a status has said them, and announces the change", () => {
    const registry = new BackendRegistry({
      local: fakeRemote().backend,
      remoteVersion: "0.0.1",
      createProvider: () =>
        ({
          kind: "ssh",
          capabilities: { canStop: false, canDestroy: false, autoSleep: false },
          ensureUp: async () => {},
          status: async () => ({ state: "up" }),
          transport: () => {
            throw new Error("unused");
          },
          forwardPort: vi.fn(),
          dispose: async () => {},
          openServerChannel: null,
        }) as unknown as HostProvider,
      createRemote: () => fakeRemote().backend,
      hostServerClient: { log: quiet },
    });
    registry.register("box", { kind: "ssh", target: "me@box" });
    const box = () => registry.list().find((h) => h.hostId === "box")!;
    expect(box()).not.toHaveProperty("viewerBridge");
    expect(box()).not.toHaveProperty("roomId");

    const changes = vi.fn();
    registry.onStatusChange(changes);
    registry.setServerFacts("box", { roomId: "room-1", viewerBridge: true });
    expect(box()).toMatchObject({ roomId: "room-1", viewerBridge: true });
    expect(changes).toHaveBeenCalledTimes(1);
    // The same facts again are no change.
    registry.setServerFacts("box", { roomId: "room-1", viewerBridge: true });
    expect(changes).toHaveBeenCalledTimes(1);
    // The local host has no server; ignored.
    registry.setServerFacts("local", { roomId: "x", viewerBridge: true });
    expect(registry.list()[0]).not.toHaveProperty("roomId");

    registry.setServerFacts("box", null);
    expect(box()).not.toHaveProperty("viewerBridge");
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("lists whether each remote host is adopted, and announces adoption", () => {
    const adopted = new Set<string>();
    const registry = new BackendRegistry({
      local: fakeRemote().backend,
      remoteVersion: "0.0.1",
      createProvider: () =>
        ({
          kind: "ssh",
          capabilities: { canStop: false, canDestroy: false, autoSleep: false },
          ensureUp: async () => {},
          status: async () => ({ state: "up" }),
          transport: () => {
            throw new Error("unused");
          },
          forwardPort: vi.fn(),
          dispose: async () => {},
          openServerChannel: null,
        }) as unknown as HostProvider,
      createRemote: () => fakeRemote().backend,
      hostServerClient: { log: quiet },
      isAdopted: (hostId) => adopted.has(hostId),
    });
    registry.register("box", { kind: "ssh", target: "me@box" });
    const box = () => registry.list().find((h) => h.hostId === "box")!;
    expect(box().adopted).toBe(false);
    expect(registry.list()[0]).not.toHaveProperty("adopted");

    const changes = vi.fn();
    registry.onStatusChange(changes);
    adopted.add("box");
    registry.adoptionChanged("box");
    expect(changes).toHaveBeenCalledOnce();
    expect(changes.mock.calls[0][0].find((h: { hostId: string }) => h.hostId === "box")).toMatchObject({
      adopted: true,
    });
    registry.adoptionChanged("nowhere");
    expect(changes).toHaveBeenCalledOnce();
  });
});

describe("adoption's records (ADR-227 D3)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manor-manifest-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function record(over: Partial<PersistedProject>): PersistedProject {
    return {
      id: "x",
      name: "x",
      path: "/x",
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      hostId: "local",
      ...over,
    };
  }

  it("takes only that host's projects, re-homed to local, groups resolved", () => {
    fs.writeFileSync(
      path.join(tmp, "projects.json"),
      JSON.stringify({
        selectedProjectIndex: 0,
        hosts: { box: { spec: { kind: "ssh", target: "me@box" } } },
        projects: [
          record({
            id: "on-box",
            name: "Own name",
            path: "/home/me/manor",
            hostId: "box",
            color: "#111",
            hostPaths: { local: "/Users/me/manor" },
            workspaceNames: { "/home/me/wt/a": "Feature A" },
          }),
          record({ id: "on-mac", path: "/Users/me/manor", hostId: "local" }),
          record({ id: "elsewhere", path: "/srv/x", hostId: "other" }),
        ],
        groups: [
          {
            id: "g1",
            name: "Manor",
            memberIds: ["on-box", "on-mac"],
            lastUsedHostId: null,
            color: "#0f0",
          },
        ],
      }),
    );
    const git = { worktreeList: vi.fn(async () => []) };
    const pm = new ProjectManager(git as never, tmp);
    const records = pm.manifestRecords("box");
    expect(records.map((p) => [p.id, p.hostId])).toEqual([["on-box", "local"]]);
    expect(records[0]).toMatchObject({ name: "Manor", color: "#0f0" });
    expect(records[0]).not.toHaveProperty("hostPaths");
    // Copies: the records cannot reach back into projects.json's state.
    records[0].workspaceNames!["/home/me/wt/a"] = "changed";
    expect(pm.manifestRecords("box")[0].workspaceNames).toEqual({
      "/home/me/wt/a": "Feature A",
    });
    expect(git.worktreeList).not.toHaveBeenCalled();
  });

  it("builds a layout snapshot of the host's keys from the store", () => {
    const snapshot = layoutSnapshotFor(
      "box",
      {
        getAll: () => ({ "box:/a": entry(2), "/local": entry(1) }),
        getLastActiveWorkspacePath: () => "/local",
      },
      new Date("2026-10-12T10:00:00.000Z"),
    );
    expect(snapshot).toEqual({
      version: 1,
      takenAt: "2026-10-12T10:00:00.000Z",
      workspaces: { "/a": entry(2) },
      lastActiveWorkspacePath: null,
    });
  });
});
