/**
 * The desktop's end of the owner channel (ADR-218 D4): `HostServerClient`
 * against a real host server in this process, reached exactly as over ssh —
 * `runServerBridge` (what `manor-host server-bridge` runs) on in-memory
 * stdio, piping to the server's unix socket — but with no ssh and no daemon.
 * And the manifest the desktop builds for it (D8), from memory only.
 */

import fs from "node:fs";
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
import type { HostManifest } from "../../host-server/manifest";
import type { HostLayoutSnapshot } from "../../host-server/layout";
import type { HostRelay } from "../../host-server/relay";
import { hostServerPaths, type HostServerPaths } from "../../paths";
import { plainFileSecretBox } from "../../platform/secret-box";
import type { HostTransport } from "../../terminal-host/transport";
import { runServerBridge } from "../../terminal-host/server-bridge";
import { awaitHelloLine, parseServerHello } from "../../terminal-host/transport-ssh";
import {
  HostServerClient,
  HostServerUnavailableError,
  type HostServerClientOptions,
} from "../host-server-client";
import {
  HostServerSync,
  buildHostManifest,
  layoutSnapshotFor,
  type ManifestSources,
} from "../host-server-sync";
import { BackendRegistry } from "../registry";
import type { HostProvider } from "../providers/types";
import type { HostConnectionEvent, RemoteHostBackend, StreamEvent } from "../types";
import { ProjectManager } from "../../projects/project-manager";
import type { PersistedProject } from "../../projects/types";
import type { LayoutEntry } from "../../../src/lib/layout/protocol";
import type { PrInfo } from "../../../src/lib/pr-info";

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
  const ended = new Promise<never>((_resolve, reject) => {
    stdout.once("error", reject);
    stdout.once("close", () => reject(new Error("the stream ended before the hello")));
  });
  ended.catch(() => {});
  // The server is already running in-process; never spawn a real one.
  runServerBridge(
    { stdin, stdout, stderr },
    { paths, ensureServerRunning: async () => {} },
  ).catch((err: Error) => {
    stdout.destroy(err);
  });
  const { rest } = await Promise.race([awaitHelloLine(stdout, parseServerHello), ended]);
  if (rest.length > 0) stdout.unshift(rest);
  return joined(stdin, stdout);
}

function manifest(projectPath: string): HostManifest {
  return {
    version: 1,
    sentAt: new Date().toISOString(),
    projects: [
      {
        id: "p1",
        name: "Manor",
        path: projectPath,
        hostId: "local",
        selectedWorkspaceIndex: 0,
        workspaces: [],
        defaultBranch: "main",
        defaultRunCommand: null,
        worktreePath: null,
      },
    ],
    integrationSnapshot: {},
  };
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

  it("connects as the owner, asks for status and syncs both payloads", async () => {
    const c = client();
    const states: string[] = [];
    c.onStateChange((state) => states.push(state));
    c.hostConnected();
    await vi.waitFor(() => expect(c.state).toBe("connected"));
    expect(states).toEqual(["connecting", "connected"]);

    const status = await c.api.hostServer.status();
    expect(status).toMatchObject({ version: "9.9.9-test", devices: 0, pushEndpoints: [] });
    expect(await c.api.remoteControl.listDevices()).toEqual([]);

    expect(await c.api.hostServer.syncManifest(manifest(tmp))).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.manifest, "utf-8")).projects[0].id).toBe("p1");

    const layout: HostLayoutSnapshot = {
      version: 1,
      takenAt: new Date().toISOString(),
      workspaces: { [tmp]: entry(4) },
      lastActiveWorkspacePath: tmp,
    };
    expect(await c.api.hostServer.syncLayout(layout)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.layout, "utf-8")).workspaces[tmp].version).toBe(4);

    // A refused payload is an error, not a dropped channel.
    await expect(c.api.hostServer.syncLayout({ ...layout, version: 2 } as never)).rejects.toThrow(
      /layout.version/,
    );
    expect(c.state).toBe("connected");
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

  it("re-sends the manifest and layout after every connect, and redials a dropped channel", async () => {
    const c = client();
    const connected = vi.fn();
    c.onStateChange((state) => {
      if (state === "connected") connected();
    });
    let manifestBuilds = 0;
    const sync = new HostServerSync({
      // The registry's part: every state change of the one host's channel.
      registry: {
        hostServer: () => c,
        hostServers: () => [c],
        onHostServerStateChange: (listener) =>
          c.onStateChange((state) => listener("box", state)),
      },
      manifest: () => {
        manifestBuilds++;
        return manifest(tmp);
      },
      layout: () => ({
        version: 1,
        takenAt: new Date().toISOString(),
        workspaces: { [tmp]: entry(1) },
        lastActiveWorkspacePath: null,
      }),
      vapidKeys: async () => ({ publicKey: "desktop-pub", privateKey: "desktop-priv" }),
      debounceMs: 10,
      log: quiet,
    });
    sync.start();

    c.hostConnected();
    await vi.waitFor(() => expect(fs.existsSync(paths.layout)).toBe(true));
    // The desktop's VAPID pair rides along with the manifest and layout.
    await vi.waitFor(() => expect(fs.existsSync(paths.vapid)).toBe(true));
    expect(fs.existsSync(paths.manifest)).toBe(true);

    // An unchanged manifest is not sent again on a change notice.
    fs.rmSync(paths.manifest);
    sync.manifestChanged("box");
    await new Promise((r) => setTimeout(r, 50));
    expect(manifestBuilds).toBe(2);
    expect(fs.existsSync(paths.manifest)).toBe(false);

    // The host reconnects: both are sent whole again.
    c.hostLost();
    expect(c.state).toBe("idle");
    c.hostConnected();
    await vi.waitFor(() => expect(fs.existsSync(paths.manifest)).toBe(true));
    expect(connected).toHaveBeenCalledTimes(2);

    // The server restarts under a connected host: the channel is redialled
    // (not marked unsupported) and both are sent again.
    fs.rmSync(paths.manifest);
    await unlisten();
    await vi.waitFor(() => expect(c.state).not.toBe("connected"));
    await listen();
    await vi.waitFor(() => expect(c.state).toBe("connected"));
    await vi.waitFor(() => expect(fs.existsSync(paths.manifest)).toBe(true));
    expect(connected).toHaveBeenCalledTimes(3);
    sync.dispose();
  });
});

describe("BackendRegistry's owner channels", () => {
  /** Just enough of a remote backend for `RemoteHostConnection`. */
  function fakeRemote() {
    const hostHandlers: Array<(event: HostConnectionEvent) => void> = [];
    const backend = {
      pty: {
        onEvent: (_h: (event: StreamEvent) => void) => () => {},
        replayHooks: async () => ({ entries: [], lastSeq: 0, epoch: "e0" }),
        listSessions: async () => [],
      },
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      onHostEvent: (handler: (event: HostConnectionEvent) => void) => {
        hostHandlers.push(handler);
        return () => {};
      },
      onStreamConnected: () => () => {},
      sendControlRelayCommand: () => true,
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
});

describe("buildHostManifest", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manor-manifest-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const pr: PrInfo = {
    number: 42,
    state: "open",
    title: "Add the thing",
    url: "https://github.com/o/r/pull/42",
    isDraft: false,
    checks: { total: 3, passing: 2, failing: 1, pending: 0 },
    recentComments: [],
    additions: 10,
  };

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
    expect(records.map((p) => p.id)).toEqual(["on-box"]);
    expect(records[0]).toMatchObject({ name: "Manor", color: "#0f0" });
    expect(records[0]).not.toHaveProperty("hostPaths");
    // Copies: the manifest cannot reach back into projects.json's state.
    records[0].workspaceNames!["/home/me/wt/a"] = "changed";
    expect(pm.manifestRecords("box")[0].workspaceNames).toEqual({
      "/home/me/wt/a": "Feature A",
    });
    expect(git.worktreeList).not.toHaveBeenCalled();

    const built = buildHostManifest("box", {
      projects: (id) => pm.manifestRecords(id),
      workspaces: () => [],
      cachedPr: () => undefined,
    });
    expect(built.version).toBe(1);
    expect(built.hostName).toBeUndefined();
    expect(
      buildHostManifest("box", {
        projects: (id) => pm.manifestRecords(id),
        workspaces: () => [],
        cachedPr: () => undefined,
        hostName: () => "me@box",
      }).hostName,
    ).toBe("me@box");
    expect(built.projects.map((p) => [p.id, p.hostId, p.name])).toEqual([
      ["on-box", "local", "Manor"],
    ]);
  });

  it("assembles the integration snapshot from what is cached, never asking for more", () => {
    const issue = {
      id: "lin-1",
      identifier: "ENG-412",
      title: "Do the thing",
      url: "https://linear.app/x/issue/ENG-412",
    };
    const prAt = Date.parse("2026-10-12T09:00:00.000Z");
    const cachedPr = vi.fn<ManifestSources["cachedPr"]>((repo, branch) => {
      expect(repo).toEqual({ path: "/home/me/manor", hostId: "box" });
      if (branch === "feat-a") return { pr, at: prAt };
      if (branch === "feat-b") return { pr: null, at: prAt };
      return undefined;
    });
    const now = new Date("2026-10-12T10:00:00.000Z");
    const built = buildHostManifest(
      "box",
      {
        projects: () => [
          {
            ...record({
              id: "on-box",
              path: "/home/me/manor",
              workspaceIssues: { "/home/me/wt/b": [issue] },
            }),
            hostId: "local" as const,
          },
        ],
        workspaces: () => [
          { path: "/home/me/manor", branch: "main" },
          { path: "/home/me/wt/a", branch: "feat-a" },
          { path: "/home/me/wt/b", branch: "feat-b" },
        ],
        cachedPr,
      },
      now,
    );
    expect(built.sentAt).toBe(now.toISOString());
    expect(built.projects[0]).not.toHaveProperty("hostPaths");
    expect(built.integrationSnapshot).toEqual({
      "/home/me/wt/a": {
        takenAt: "2026-10-12T09:00:00.000Z",
        issue: null,
        pr: {
          number: 42,
          state: "open",
          title: "Add the thing",
          url: "https://github.com/o/r/pull/42",
          isDraft: false,
          checks: { total: 3, passing: 2, failing: 1, pending: 0 },
        },
      },
      "/home/me/wt/b": {
        takenAt: now.toISOString(),
        issue: {
          id: "lin-1",
          identifier: "ENG-412",
          title: "Do the thing",
          url: "https://linear.app/x/issue/ENG-412",
        },
        pr: null,
      },
    });
    expect(cachedPr).toHaveBeenCalledTimes(3);
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
