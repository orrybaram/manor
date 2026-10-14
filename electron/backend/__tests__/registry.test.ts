import { describe, it, expect, vi } from "vitest";
import {
  BackendRegistry,
  HostUnavailableError,
  isRemoteSessionLoss,
  type HostStatusInfo,
} from "../registry";
import { RoutedBackend } from "../routed-backend";
import type { HostConnection } from "../host-connection";
import type {
  ScannedPort,
  HostConnectionEvent,
  HostSpec,
  RemoteHostBackend,
  StreamEvent,
  PaneFacts,
} from "../types";
import { SshAuthError } from "../../terminal-host/ssh-config";
import type { HostProvider, ProviderState } from "../providers/types";

/** A WorkspaceBackend whose every call is a spy, plus handles to drive it. */
function fakeBackend(name: string) {
  let streamHandler: ((event: StreamEvent) => void) | null = null;
  const hostHandlers: Array<(event: HostConnectionEvent) => void> = [];
  const raw = {
    pty: {
      createOrAttach: vi.fn(async (sessionId: string, cwd: string) => ({
        session: { sessionId, cwd, cols: 80, rows: 24, alive: true },
        snapshot: null,
      })),
      write: vi.fn(),
      resize: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      getSnapshot: vi.fn(async () => null),
      getPaneFacts: vi.fn(async (): Promise<PaneFacts | null> => null),
      listSessions: vi.fn(async () => [] as Array<{ sessionId: string }>),
      disposeDead: vi.fn(async () => {}),
      onEvent: vi.fn((handler: (event: StreamEvent) => void) => {
        streamHandler = handler;
        return () => {
          if (streamHandler === handler) streamHandler = null;
        };
      }),
      updateEnv: vi.fn(async () => {}),
    },
    git: {
      exec: vi.fn(async () => `${name}-out`),
      pushStream: vi.fn(() => ({ cancel: vi.fn() })),
      getStagedFiles: vi.fn(async () => [`${name}.txt`]),
    },
    shell: {
      which: vi.fn(async (bin: string) => `/${name}/bin/${bin}`),
      exec: vi.fn(async () => ""),
    },
    ports: {
      scan: vi.fn(async (): Promise<ScannedPort[]> => []),
      kill: vi.fn(async () => {}),
    },
    facts: {
      homeDir: vi.fn(async () => `/home/${name}`),
      join: vi.fn((...parts: string[]) => parts.join("/")),
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    onHostEvent: vi.fn((handler: (event: HostConnectionEvent) => void) => {
      hostHandlers.push(handler);
      return () => {
        const i = hostHandlers.indexOf(handler);
        if (i >= 0) hostHandlers.splice(i, 1);
      };
    }),
    retryNow: vi.fn(() => false),
    checkLiveness: vi.fn(async () => true),
  };
  return {
    raw,
    backend: raw as unknown as RemoteHostBackend,
    stream: (event: StreamEvent) => streamHandler?.(event),
    hostEvent: (event: HostConnectionEvent) => {
      for (const h of hostHandlers) h(event);
    },
    /** Whether anything is still subscribed to this backend's events. */
    listening: () =>
      streamHandler !== null || hostHandlers.length > 0,
  };
}

/** A HostProvider whose every call is a spy. */
function fakeProvider() {
  const provider = {
    kind: "ssh" as const,
    capabilities: { canStop: false, canDestroy: false, autoSleep: false },
    ensureUp: vi.fn(async (_onProgress?: (line: string) => void) => {}),
    status: vi.fn(async (): Promise<{ state: ProviderState; detail?: string; missing?: boolean }> => ({ state: "up" })),
    transport: vi.fn(() => {
      throw new Error("fake provider has no transport");
    }),
    forwardPort: vi.fn(async () => ({ localPort: 1, dispose: vi.fn() })),
    dispose: vi.fn(async () => {}),
  };
  return provider;
}

/** `ensureConnected` calls the backend's `connect`, which lands a tick later. */
async function connectStarted(remote: ReturnType<typeof fakeBackend>, times = 1) {
  await vi.waitFor(() => expect(remote.raw.connect).toHaveBeenCalledTimes(times));
}

function setup() {
  const local = fakeBackend("local");
  const remotes = new Map<string, ReturnType<typeof fakeBackend>>();
  const providers = new Map<string, ReturnType<typeof fakeProvider>>();
  const progress = new Map<string, (message: string) => void>();
  const warn = new Map<string, (warnings: string[]) => void>();
  const replacing = new Map<string, (sessionIds: string[]) => void>();
  const registry = new BackendRegistry({
    local: local.backend,
    remoteVersion: "0.1.0",
    createProvider: (hostId, _spec: HostSpec, opts) => {
      const provider = fakeProvider();
      providers.set(hostId, provider);
      progress.set(hostId, (message) =>
        opts.onBootstrapProgress({ phase: "install", target: hostId, message }),
      );
      return provider as unknown as HostProvider;
    },
    createRemote: (hostId, _spec: HostSpec, opts) => {
      const fake = fakeBackend(hostId);
      remotes.set(hostId, fake);
      expect(opts.provider).toBe(providers.get(hostId));
      warn.set(hostId, opts.onBootstrapWarning);
      replacing.set(hostId, opts.onDaemonReplacing);
      return fake.backend;
    },
  });
  return { registry, local, remotes, providers, progress, warn, replacing };
}

const box: HostSpec = { kind: "ssh", target: "me@box" };

/**
 * What `list()` stamps on `box`, a plain ssh box: its provider's kind and
 * capabilities (ADR-229 D1), and its name (D2).
 */
const SSH_FACTS = {
  label: "me@box",
  providerKind: "ssh",
  capabilities: { canStop: false, canDestroy: false, autoSleep: false },
} as const;

describe("BackendRegistry", () => {
  it("always has the local host, handing out the local backend unwrapped in behavior", async () => {
    const { registry, local } = setup();
    expect(registry.list()).toEqual([
      { hostId: "local", spec: null, status: "disconnected" },
    ]);
    // Local git is never gated, even before connect.
    await expect(registry.get("local").git.exec("/p", ["status"])).resolves.toBe(
      "local-out",
    );
    registry.get("local").pty.write("pane-1", "x");
    expect(local.raw.pty.write).toHaveBeenCalledWith("pane-1", "x");

    await registry.ensureConnected("local");
    expect(local.raw.connect).toHaveBeenCalledWith();
    expect(registry.status("local")).toBe("connected");
  });

  it("hands remote hosts remoteVersion once, when their backend is built", async () => {
    const local = fakeBackend("local");
    let remote: ReturnType<typeof fakeBackend> | undefined;
    let createdWith: string | undefined;
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.13.2",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: (hostId, _spec: HostSpec, opts) => {
        createdWith = opts.version;
        remote = fakeBackend(hostId);
        return remote.backend;
      },
    });
    registry.register("box", box);
    await registry.ensureConnected("box");
    await registry.ensureConnected("local");
    expect(createdWith).toBe("0.13.2");
    expect(remote?.raw.connect).toHaveBeenCalledWith();
    expect(local.raw.connect).toHaveBeenCalledWith();
  });

  it("fails every call on an unregistered host instead of throwing synchronously", async () => {
    const { registry } = setup();
    const ghost = registry.get("ghost");
    await expect(ghost.git.exec("/p", [])).rejects.toBeInstanceOf(HostUnavailableError);
    const onDone = vi.fn();
    ghost.git.pushStream("/p", {}, { onLine: vi.fn(), onDone });
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: null }),
    );
    expect(() => ghost.pty.write("pane-1", "x")).not.toThrow();
  });

  it("tracks status through connect, bootstrap progress and host events", async () => {
    const { registry, remotes, progress } = setup();
    const seen: HostStatusInfo[][] = [];
    registry.onStatusChange((hosts) => seen.push(hosts));

    registry.register("box", box);
    expect(registry.list()[1]).toEqual({ hostId: "box", spec: box, status: "disconnected", ...SSH_FACTS });
    // Registering the same spec again is a no-op.
    registry.register("box", box);
    expect(remotes.size).toBe(1);

    let finishConnect!: () => void;
    remotes.get("box")!.raw.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishConnect = resolve)),
    );
    const connecting = registry.ensureConnected("box");
    expect(registry.status("box")).toBe("connecting");
    await connectStarted(remotes.get("box")!);
    progress.get("box")!("Installing manor-host…");
    expect(registry.list()[1]).toMatchObject({
      status: "connecting",
      progress: "Installing manor-host…",
    });
    finishConnect();
    await connecting;
    expect(registry.list()[1]).toEqual({ hostId: "box", spec: box, status: "connected", ...SSH_FACTS });

    const remote = remotes.get("box")!;
    remote.hostEvent({ type: "hostDisconnected", sessionIds: ["pane-a"], retryInMs: 1000 });
    expect(registry.list()[1]).toMatchObject({ status: "reconnecting", retryInMs: 1000 });
    expect(registry.sessions.ownerOf("pane-a")).toBe("box");

    remote.hostEvent({ type: "hostReconnected", sessionIds: ["pane-a"] });
    expect(registry.status("box")).toBe("connected");

    remote.hostEvent({
      type: "hostFailed",
      sessionIds: ["pane-a"],
      reason: "bootstrap",
      code: "node-missing",
      message: "Node 20+ is required",
    });
    expect(registry.list()[1]).toEqual({
      hostId: "box",
      spec: box,
      status: "error",
      error: "Node 20+ is required",
      failure: { reason: "bootstrap", code: "node-missing", message: "Node 20+ is required" },
      ...SSH_FACTS,
    });

    const statuses = seen.map((hosts) => hosts.find((h) => h.hostId === "box")?.status);
    expect(statuses).toEqual([
      "disconnected",
      "connecting",
      "connecting",
      "connected",
      "reconnecting",
      "connected",
      "error",
    ]);
  });

  it("reports a failed connect with its classified reason", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    remotes.get("box")!.raw.connect.mockRejectedValueOnce(
      new SshAuthError("me@box", "Permission denied (publickey)"),
    );
    await expect(registry.ensureConnected("box")).rejects.toBeInstanceOf(SshAuthError);
    expect(registry.list()[1]).toMatchObject({
      status: "error",
      failure: { reason: "auth" },
    });
    // ensureConnected is the retry.
    await registry.ensureConnected("box");
    expect(registry.status("box")).toBe("connected");
  });

  it("carries a bootstrap warning reported mid-connect through to the connected state", async () => {
    const { registry, warn } = setup();
    registry.register("box", box);
    const connecting = registry.ensureConnected("box");
    // The warning arrives while still "connecting" (bootstrapHost runs near
    // the end of RemoteBackend.connect(), before it resolves).
    warn.get("box")!(["skipped an unparseable agent config"]);
    expect(registry.list()[1]).toMatchObject({
      status: "connecting",
      warnings: ["skipped an unparseable agent config"],
    });
    await connecting;
    expect(registry.list()[1]).toMatchObject({
      status: "connected",
      warnings: ["skipped an unparseable agent config"],
    });
  });

  it("keeps bootstrap warnings across an auto-reconnect blip", async () => {
    const { registry, warn, remotes } = setup();
    registry.register("box", box);
    const connecting = registry.ensureConnected("box");
    warn.get("box")!(["skipped an unparseable agent config"]);
    await connecting;

    const remote = remotes.get("box")!;
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    expect(registry.list()[1]).toMatchObject({
      status: "reconnecting",
      warnings: ["skipped an unparseable agent config"],
    });
    remote.hostEvent({ type: "hostReconnected", sessionIds: [] });
    expect(registry.list()[1]).toMatchObject({
      status: "connected",
      warnings: ["skipped an unparseable agent config"],
    });
  });

  it("fails git fast on a host that is not connected, and connects it in the background", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    let finishConnect!: () => void;
    remote.raw.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishConnect = resolve)),
    );

    await expect(registry.get("box").git.exec("/r", [])).rejects.toBeInstanceOf(
      HostUnavailableError,
    );
    expect(remote.raw.git.exec).not.toHaveBeenCalled();
    expect(registry.status("box")).toBe("connecting");
    // Still connecting: still fails fast.
    await expect(registry.get("box").git.exec("/r", [])).rejects.toBeInstanceOf(
      HostUnavailableError,
    );

    finishConnect();
    await vi.waitFor(() => expect(registry.status("box")).toBe("connected"));
    await expect(registry.get("box").git.exec("/r", [])).resolves.toBe("box-out");
  });

  it("gates a remote host's facts like its git calls, except the synchronous join", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    remote.raw.connect.mockImplementationOnce(() => new Promise<void>(() => {}));

    const facts = registry.get("box").facts;
    expect(facts.join("/a", "b")).toBe("/a/b");
    await expect(facts.homeDir()).rejects.toBeInstanceOf(HostUnavailableError);
    expect(remote.raw.facts.homeDir).not.toHaveBeenCalled();
    // An unregistered host still joins, and fails everything else.
    expect(registry.get("ghost").facts.join("/a", "b")).toBe("/a/b");
    await expect(registry.get("ghost").facts.homeDir()).rejects.toBeInstanceOf(
      HostUnavailableError,
    );
  });

  it("does not reconnect a host the user disconnected just because a poller asked", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    await registry.ensureConnected("box");
    await registry.disconnect("box");
    const remote = remotes.get("box")!;
    remote.raw.connect.mockClear();
    await expect(registry.get("box").ports.scan([])).rejects.toBeInstanceOf(
      HostUnavailableError,
    );
    expect(remote.raw.connect).not.toHaveBeenCalled();
  });

  it("keeps a disconnect made while a connect is in flight that then succeeds", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    let finishConnect!: () => void;
    remote.raw.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishConnect = resolve)),
    );
    const connecting = registry.ensureConnected("box");
    expect(registry.status("box")).toBe("connecting");
    await connectStarted(remote);

    await registry.disconnect("box");
    expect(registry.status("box")).toBe("disconnected");
    finishConnect();
    // The cancelled attempt neither resolves (its client is disposed) nor
    // marks the host connected.
    await expect(connecting).rejects.toBeInstanceOf(HostUnavailableError);
    expect(registry.status("box")).toBe("disconnected");
  });

  it("keeps a disconnect made while a connect is in flight that then fails", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    let failConnect!: (err: Error) => void;
    remote.raw.connect.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (failConnect = reject)),
    );
    const connecting = registry.ensureConnected("box");
    await connectStarted(remote);

    await registry.disconnect("box");
    // Disposing the client makes the in-flight connect reject.
    failConnect(new Error("client disposed"));
    await expect(connecting).rejects.toBeInstanceOf(HostUnavailableError);
    expect(registry.list()[1]).toEqual({ hostId: "box", spec: box, status: "disconnected", ...SSH_FACTS });

    // An explicit connect afterwards still works, and the stale attempt
    // does not interfere with it.
    await registry.ensureConnected("box");
    expect(registry.status("box")).toBe("connected");
  });

  it("a stale attempt does not clobber a newer connect started after a disconnect", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    let failFirst!: (err: Error) => void;
    remote.raw.connect.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (failFirst = reject)),
    );
    const first = registry.ensureConnected("box");
    await connectStarted(remote);
    await registry.disconnect("box");
    await registry.ensureConnected("box");
    expect(registry.status("box")).toBe("connected");

    failFirst(new Error("client disposed"));
    await expect(first).rejects.toBeInstanceOf(HostUnavailableError);
    expect(registry.status("box")).toBe("connected");
  });

  it("waits for the connection before a pty call", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    await registry.get("box").pty.createOrAttach("pane-1", "/r", 80, 24);
    expect(remote.raw.connect).toHaveBeenCalledTimes(1);
    expect(remote.raw.pty.createOrAttach).toHaveBeenCalledWith("pane-1", "/r", 80, 24);
  });

  it("waits for the connection before getPaneFacts, like any pty call (ADR-184)", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    await registry.get("box").pty.getPaneFacts("pane-1");
    expect(remote.raw.connect).toHaveBeenCalledTimes(1);
    expect(remote.raw.pty.getPaneFacts).toHaveBeenCalledWith("pane-1");
  });

  it("tags stream events with their host and drops events for another host's session", () => {
    const { registry, local, remotes } = setup();
    registry.register("box", box);
    const events: Array<[string, StreamEvent]> = [];
    registry.onEvent((hostId, event) => events.push([hostId, event]));

    remotes.get("box")!.stream({ type: "data", sessionId: "pane-r", data: "hi" });
    local.stream({ type: "data", sessionId: "pane-l", data: "yo" });
    // pane-r belongs to box; the same id from local is not delivered.
    local.stream({ type: "data", sessionId: "pane-r", data: "imposter" });

    expect(events).toEqual([
      ["box", { type: "data", sessionId: "pane-r", data: "hi" }],
      ["local", { type: "data", sessionId: "pane-l", data: "yo" }],
    ]);
    expect(registry.sessions.ownerOf("pane-r")).toBe("box");
  });

  it("ignores a replaced host's old backend", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const old = remotes.get("box")!;
    registry.register("box", { kind: "ssh", target: "me@other" });
    // The provider's forwards are cancelled first, then the backend dropped.
    await vi.waitFor(() => expect(old.raw.disconnect).toHaveBeenCalled());
    old.hostEvent({ type: "hostReconnected", sessionIds: [] });
    expect(registry.status("box")).toBe("disconnected");
  });
});

describe("BackendRegistry providers", () => {
  it("registers a provider per remote host, none for the local one", async () => {
    const { registry, providers } = setup();
    registry.register("box", box);
    await registry.ensureConnected("box");
    expect(registry.provider("box")).toBe(providers.get("box"));
    expect(registry.provider("local")).toBeUndefined();
  });

  it("disposes the provider on disconnect, replace and unregister", async () => {
    const { registry, providers } = setup();
    registry.register("box", box);
    const first = providers.get("box")!;
    await registry.disconnect("box");
    expect(first.dispose).toHaveBeenCalledTimes(1);
    registry.register("box", { kind: "ssh", target: "me@other" });
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(2));
    const second = providers.get("box")!;
    await registry.unregister("box");
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from a replaced or unregistered backend's events", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const first = remotes.get("box")!;
    expect(first.listening()).toBe(true);
    registry.register("box", { kind: "ssh", target: "me@other" });
    await vi.waitFor(() => expect(first.listening()).toBe(false));
    const second = remotes.get("box")!;
    expect(second.listening()).toBe(true);
    await registry.unregister("box");
    expect(second.listening()).toBe(false);
  });
});

describe("RoutedBackend", () => {
  function routed() {
    const ctx = setup();
    ctx.registry.register("box", box);
    const hostForPath = (p: string) => (p.startsWith("/remote") ? "box" : "local");
    const backend = new RoutedBackend(ctx.registry, hostForPath);
    return { ...ctx, backend, box: ctx.remotes.get("box")! };
  }

  it("stops delivering stream and host events once unsubscribed", () => {
    const { backend, registry, box: remote } = routed();
    const events: StreamEvent[] = [];
    const hostEvents: HostConnectionEvent[] = [];
    const offStream = backend.pty.onEvent((e) => events.push(e));
    const offHost = registry.onHostEvent((_hostId, e) => hostEvents.push(e));
    const back: HostConnectionEvent = { type: "hostReconnected", sessionIds: [] };

    remote.stream({ type: "data", sessionId: "pane-r", data: "a" });
    remote.hostEvent(back);
    offStream();
    offHost();
    remote.stream({ type: "data", sessionId: "pane-r", data: "b" });
    remote.hostEvent(back);

    expect(events).toEqual([{ type: "data", sessionId: "pane-r", data: "a" }]);
    expect(hostEvents).toEqual([back]);
  });

  it("creates a pane on the host its cwd belongs to, then routes the pane there", async () => {
    const { backend, local, box: remote } = routed();
    await backend.pty.createOrAttach("pane-r", "/remote/app", 80, 24);
    await backend.pty.createOrAttach("pane-l", "/Users/me/app", 80, 24);
    expect(remote.raw.pty.createOrAttach).toHaveBeenCalledWith(
      "pane-r", "/remote/app", 80, 24, undefined, undefined,
    );
    expect(local.raw.pty.createOrAttach).toHaveBeenCalledWith(
      "pane-l", "/Users/me/app", 80, 24, undefined, undefined,
    );

    backend.pty.write("pane-r", "ls\n");
    await backend.pty.resize("pane-r", 100, 30);
    expect(remote.raw.pty.write).toHaveBeenCalledWith("pane-r", "ls\n");
    expect(remote.raw.pty.resize).toHaveBeenCalledWith("pane-r", 100, 30);
    expect(local.raw.pty.write).not.toHaveBeenCalled();

    // Unknown panes are local, as every pane was before hosts.
    backend.pty.write("pane-x", "y");
    expect(local.raw.pty.write).toHaveBeenCalledWith("pane-x", "y");
  });

  it("reaches a pane this process never attached on the host whose layout holds it (ADR-228 D5)", async () => {
    const ctx = setup();
    ctx.registry.register("box", box);
    const backend = new RoutedBackend(
      ctx.registry,
      () => "local",
      () => [],
      undefined,
      (paneId) => (paneId === "pane-w" ? "box" : null),
    );
    const remote = ctx.remotes.get("box")!;
    await ctx.registry.ensureConnected("box");

    await backend.pty.getSnapshot("pane-w");
    backend.pty.write("pane-w", "ls\n");
    expect(remote.raw.pty.getSnapshot).toHaveBeenCalledWith("pane-w");
    expect(remote.raw.pty.write).toHaveBeenCalledWith("pane-w", "ls\n");
    // A pane no layout holds is still this machine's.
    backend.pty.write("pane-x", "y");
    expect(ctx.local.raw.pty.write).toHaveBeenCalledWith("pane-x", "y");
  });

  it("routes getPaneFacts to the host that owns the pane (ADR-184)", async () => {
    const { backend, local, box: remote } = routed();
    const facts: PaneFacts = {
      foreground: { name: "claude", kind: "claude" },
      title: null,
      outputHint: null,
    };
    remote.raw.pty.getPaneFacts.mockResolvedValueOnce(facts);
    await backend.pty.createOrAttach("pane-r", "/remote/app", 80, 24);

    await expect(backend.pty.getPaneFacts("pane-r")).resolves.toEqual(facts);
    await expect(backend.pty.getPaneFacts("pane-x")).resolves.toBeNull();
    expect(remote.raw.pty.getPaneFacts).toHaveBeenCalledWith("pane-r");
    expect(local.raw.pty.getPaneFacts).toHaveBeenCalledWith("pane-x");
  });

  it("routes git by cwd", async () => {
    const { backend, registry } = routed();
    await registry.ensureConnected("box");
    await expect(backend.git.getStagedFiles("/remote/app")).resolves.toEqual(["box.txt"]);
    await expect(backend.git.getStagedFiles("/Users/me/app")).resolves.toEqual(["local.txt"]);
  });

  it("lists sessions from local and connected hosts, skipping a failing remote", async () => {
    const { backend, registry, local, box: remote } = routed();
    local.raw.pty.listSessions.mockResolvedValue([{ sessionId: "pane-l" }]);
    remote.raw.pty.listSessions.mockResolvedValue([{ sessionId: "pane-r" }]);

    // Not connected: not asked.
    expect((await backend.pty.listSessions()).map((s) => s.sessionId)).toEqual(["pane-l"]);
    expect(remote.raw.pty.listSessions).not.toHaveBeenCalled();

    await registry.ensureConnected("box");
    expect((await backend.pty.listSessions()).map((s) => s.sessionId)).toEqual([
      "pane-l",
      "pane-r",
    ]);
    expect(registry.sessions.ownerOf("pane-r")).toBe("box");

    remote.raw.pty.listSessions.mockRejectedValueOnce(new Error("ssh died"));
    expect((await backend.pty.listSessions()).map((s) => s.sessionId)).toEqual(["pane-l"]);
  });

  it("kills a pid on the host whose latest scan reported it", async () => {
    const ctx = setup();
    ctx.registry.register("box", box);
    const pidHosts: Record<number, string[]> = { 1: ["local"], 2: ["box"], 3: ["local", "box"] };
    const backend = new RoutedBackend(
      ctx.registry,
      () => "local",
      (pid) => pidHosts[pid] ?? [],
    );
    const remote = ctx.remotes.get("box")!;
    await ctx.registry.ensureConnected("box");

    await backend.ports.kill(2);
    expect(remote.raw.ports.kill).toHaveBeenCalledWith(2);
    await backend.ports.kill(1);
    expect(ctx.local.raw.ports.kill).toHaveBeenCalledWith(1);
    // A pid no scan reported is this machine's, as every pid was before hosts.
    await backend.ports.kill(4);
    expect(ctx.local.raw.ports.kill).toHaveBeenCalledWith(4);
    await expect(backend.ports.kill(3)).rejects.toThrow(/more than one host/);
  });

  it("reports the host createOrAttach used", async () => {
    const { backend } = routed();
    await expect(backend.pty.createOrAttach("pane-r", "/remote/app", 80, 24)).resolves.toMatchObject({
      hostId: "box",
    });
    await expect(backend.pty.createOrAttach("pane-l", "/Users/me/app", 80, 24)).resolves.toMatchObject({
      hostId: "local",
    });
  });

  it("never creates or attaches a session its host's server serves (ADR-228 D5)", async () => {
    const ctx = setup();
    ctx.registry.register("box", box);
    let served = true;
    const backend = new RoutedBackend(
      ctx.registry,
      (p) => (p.startsWith("/remote") ? "box" : "local"),
      () => [],
      (hostId) => served && hostId === "box",
      (paneId) => (paneId === "pane-placed" ? "box" : null),
    );
    const remote = ctx.remotes.get("box")!;
    await ctx.registry.ensureConnected("box");

    // `box`'s server creates and attaches its panes, over its own bridge.
    await expect(backend.pty.createOrAttach("pane-r", "/remote/app", 80, 24)).rejects.toThrow(
      /whose own server attaches it/,
    );
    await expect(backend.pty.attachExisting("pane-placed")).rejects.toThrow(
      /whose own server attaches it/,
    );
    expect(remote.raw.pty.createOrAttach).not.toHaveBeenCalled();
    // A request about a running session still reaches the host it runs on.
    backend.pty.write("pane-placed", "ls\r");
    expect(remote.raw.pty.write).toHaveBeenCalledWith("pane-placed", "ls\r");
    // The desktop's own sessions are its own.
    await backend.pty.createOrAttach("pane-l", "/Users/me/app", 80, 24);
    expect(ctx.local.raw.pty.createOrAttach).toHaveBeenCalled();

    // A host not served by its own server: the daemon creates it, as before.
    served = false;
    await expect(backend.pty.createOrAttach("pane-r", "/remote/app", 80, 24)).resolves.toMatchObject({
      hostId: "box",
    });
    expect(remote.raw.pty.createOrAttach).toHaveBeenCalledWith(
      "pane-r", "/remote/app", 80, 24, undefined, undefined,
    );
  });

  it("fails a pty call with HostUnavailableError only while its host is away (ADR-183)", async () => {
    const { backend, registry, box: remote } = routed();
    remote.raw.connect.mockRejectedValueOnce(new Error("ssh: connection refused"));
    const away = await backend.pty
      .createOrAttach("pane-r", "/remote/app", 80, 24)
      .catch((e: unknown) => e);
    expect(away).toBeInstanceOf(HostUnavailableError);
    expect(away).toMatchObject({ hostId: "box", status: "error" });

    // Once connected, a failure is the terminal's own.
    await registry.ensureConnected("box");
    remote.raw.pty.createOrAttach.mockRejectedValueOnce(new Error("spawn failed"));
    const broken = await backend.pty
      .createOrAttach("pane-r2", "/remote/app", 80, 24)
      .catch((e: unknown) => e);
    expect(broken).not.toBeInstanceOf(HostUnavailableError);
    expect(broken).toMatchObject({ message: "spawn failed" });
  });

  it("with only the local host, passes every call straight to it", async () => {
    const local = fakeBackend("local");
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
    });
    const backend = new RoutedBackend(registry, () => "local");
    await backend.pty.createOrAttach("pane-1", "/anywhere", 80, 24);
    await backend.ports.scan(["/a", "/b"]);
    await backend.shell.which("git");
    expect(local.raw.pty.createOrAttach).toHaveBeenCalledWith(
      "pane-1", "/anywhere", 80, 24, undefined, undefined,
    );
    expect(local.raw.ports.scan).toHaveBeenCalledWith(["/a", "/b"]);
    expect(local.raw.shell.which).toHaveBeenCalledWith("git");
  });
});

describe("BackendRegistry — remote agent hooks (ADR-227 D4)", () => {
  it("ignores a remote daemon's hookEvents: the host's server reads its journal", async () => {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    const replayHooks = vi.fn();
    (remote.raw.pty as Record<string, unknown>).replayHooks = replayHooks;
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: () => remote.backend,
    });
    registry.register("box", box);
    const listener = vi.fn();
    registry.onEvent(listener);

    await registry.ensureConnected("box");
    remote.stream({ type: "hookEvent", seq: 1, payload: { tag: "1" } });

    expect(replayHooks).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("records the host's sessions on connect, so calls for a pane reach the remote daemon", async () => {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    remote.raw.pty.listSessions.mockResolvedValue([{ sessionId: "pane-remote" }]);
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: () => remote.backend,
    });
    const routed = new RoutedBackend(registry, () => "local");
    registry.register("box", box);

    // A fresh launch: nothing has been created or attached on the box yet.
    expect(registry.sessions.ownerOf("pane-remote")).toBeUndefined();
    await registry.ensureConnected("box");
    await vi.waitFor(() => expect(registry.sessions.ownerOf("pane-remote")).toBe("box"));

    routed.pty.write("pane-remote", "x");
    expect(remote.raw.pty.write).toHaveBeenCalledWith("pane-remote", "x");
    expect(local.raw.pty.write).not.toHaveBeenCalled();
  });
});

describe("BackendRegistry — away and back (ADR-178 §6)", () => {
  it("tells a remote session lost to a daemon restart apart from a shell exit", () => {
    const lost = { type: "exit" as const, sessionId: "p", exitCode: -1, lost: true as const };
    const exited = { type: "exit" as const, sessionId: "p", exitCode: 0 };
    expect(isRemoteSessionLoss("box", lost)).toBe(true);
    expect(isRemoteSessionLoss("box", exited)).toBe(false);
    // The local daemon's loss still closes panes (ADR-169).
    expect(isRemoteSessionLoss("local", lost)).toBe(false);
  });

  it("keeps a lost remote session's host, so its pane is recreated there", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    await registry.ensureConnected("box");
    const listener = vi.fn();
    registry.onEvent(listener);
    remotes.get("box")!.stream({ type: "data", sessionId: "pane-a", data: "x" });
    remotes.get("box")!.stream({ type: "exit", sessionId: "pane-a", exitCode: -1, lost: true });
    expect(registry.sessions.ownerOf("pane-a")).toBe("box");
    // Still published: renderer-side listeners still need to hear it.
    expect(listener).toHaveBeenLastCalledWith("box", expect.objectContaining({ lost: true }));

    remotes.get("box")!.stream({ type: "data", sessionId: "pane-b", data: "x" });
    remotes.get("box")!.stream({ type: "exit", sessionId: "pane-b", exitCode: 0 });
    expect(registry.sessions.ownerOf("pane-b")).toBeUndefined();
  });

  function resumeSetup() {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: () => remote.backend,
    });
    registry.register("box", box);
    const resumed: Array<{ hostId: string; sessionIds: string[] }> = [];
    registry.onHostResumed((hostId, sessionIds) => {
      resumed.push({ hostId, sessionIds });
    });
    return { registry, remote, resumed };
  }

  it("announces a resumed host with every live session", async () => {
    const { registry, remote, resumed } = resumeSetup();
    await registry.ensureConnected("box");
    // The initial connect is not a reconnect: nothing to reattach.
    expect(resumed).toEqual([]);

    remote.raw.pty.listSessions.mockResolvedValue([{ sessionId: "pane-a" }]);
    remote.hostEvent({ type: "hostDisconnected", sessionIds: ["pane-a", "pane-b"], retryInMs: 1000 });
    remote.hostEvent({ type: "hostReconnected", sessionIds: ["pane-a"] });
    await vi.waitFor(() => expect(resumed).toHaveLength(1));
    expect(resumed[0]).toEqual({ hostId: "box", sessionIds: ["pane-a"] });
  });

  it("drops the announcement when the host drops again before it is made", async () => {
    const { registry, remote, resumed } = resumeSetup();
    await registry.ensureConnected("box");
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    remote.hostEvent({ type: "hostReconnected", sessionIds: [] });
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    expect(resumed).toEqual([]);
  });

  it("counts down to each reconnect attempt", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    await registry.ensureConnected("box");
    const before = Date.now();
    remotes.get("box")!.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    const first = registry.list().find((h) => h.hostId === "box")!;
    expect(first.retryAt).toBeGreaterThanOrEqual(before + 1000);
    remotes.get("box")!.hostEvent({ type: "hostRetrying", sessionIds: [], retryInMs: 30_000 });
    const next = registry.list().find((h) => h.hostId === "box")!;
    expect(next).toMatchObject({ status: "reconnecting", retryInMs: 30_000 });
    expect(next.retryAt).toBeGreaterThanOrEqual(before + 30_000);
  });

  it("Retry now wakes a reconnecting backend instead of starting a second connect", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    await registry.ensureConnected("box");
    const remote = remotes.get("box")!;
    const retryNow = vi.fn(() => true);
    (remote.raw as Record<string, unknown>).retryNow = retryNow;
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });

    registry.retryNow("box");
    expect(retryNow).toHaveBeenCalledTimes(1);
    expect(remote.raw.connect).toHaveBeenCalledTimes(1);
    // The woken loop is attempting now: the countdown says so at once.
    const info = registry.list().find((h) => h.hostId === "box")!;
    expect(info.status).toBe("reconnecting");
    expect(info.retryAt).toBeLessThanOrEqual(Date.now());

    // Mid-attempt the loop has no wait to cut short; the attempt it is
    // making is left alone rather than raced by a second connect.
    retryNow.mockReturnValue(false);
    registry.retryNow("box");
    expect(retryNow).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remote.raw.connect).toHaveBeenCalledTimes(1);

    // A host in error has no loop to wake: it connects afresh.
    remote.hostEvent({ type: "hostFailed", sessionIds: [], reason: "auth", message: "denied" });
    registry.retryNow("box");
    await connectStarted(remote, 2);
  });

  describe("checkRemoteHosts (ADR-188 §3)", () => {
    it("pings a connected host", async () => {
      const { registry, remotes } = setup();
      registry.register("box", box);
      await registry.ensureConnected("box");
      const remote = remotes.get("box")!;

      registry.checkRemoteHosts();
      expect(remote.raw.checkLiveness).toHaveBeenCalledTimes(1);
      expect(remote.raw.retryNow).not.toHaveBeenCalled();
    });

    it("retries now instead of pinging a reconnecting host", async () => {
      const { registry, remotes } = setup();
      registry.register("box", box);
      await registry.ensureConnected("box");
      const remote = remotes.get("box")!;
      remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });

      registry.checkRemoteHosts();
      expect(remote.raw.retryNow).toHaveBeenCalledTimes(1);
      expect(remote.raw.checkLiveness).not.toHaveBeenCalled();
    });

    it("does nothing for a host that is not connected or reconnecting", async () => {
      const { registry, remotes } = setup();
      registry.register("box", box);
      await registry.ensureConnected("box");
      const remote = remotes.get("box")!;
      remote.hostEvent({ type: "hostFailed", sessionIds: [], reason: "auth", message: "denied" });

      registry.checkRemoteHosts();
      expect(remote.raw.checkLiveness).not.toHaveBeenCalled();
      expect(remote.raw.retryNow).not.toHaveBeenCalled();
    });

    it("does nothing for a host that has never connected", () => {
      const { registry, remotes } = setup();
      registry.register("box", box);
      registry.checkRemoteHosts();
      const remote = remotes.get("box")!;
      expect(remote.raw.checkLiveness).not.toHaveBeenCalled();
      expect(remote.raw.retryNow).not.toHaveBeenCalled();
    });

    it("leaves the local host alone", () => {
      const { registry, local } = setup();
      registry.checkRemoteHosts();
      expect(local.raw.checkLiveness).not.toHaveBeenCalled();
      expect(local.raw.retryNow).not.toHaveBeenCalled();
    });
  });

  describe("daemon replacing (ADR-185 §A)", () => {
    /** Every host's connection, keyed by hostId; not part of the public API. */
    function connections(registry: BackendRegistry): Map<string, HostConnection> {
      return (registry as unknown as { hosts: Map<string, HostConnection> }).hosts;
    }

    it("forwards a host's reportDaemonReplacing as a registry event", () => {
      const { registry } = setup();
      const seen: Array<{ hostId: string; sessionIds: string[] }> = [];
      registry.onDaemonReplacing((hostId, sessionIds) => seen.push({ hostId, sessionIds }));

      connections(registry).get("local")!.reportDaemonReplacing(["pane-1", "pane-2"]);

      expect(seen).toEqual([{ hostId: "local", sessionIds: ["pane-1", "pane-2"] }]);
    });

    it("reports a remote host's daemon replacement too, tagged with its hostId", async () => {
      const { registry } = setup();
      registry.register("box", box);
      const seen: Array<{ hostId: string; sessionIds: string[] }> = [];
      registry.onDaemonReplacing((hostId, sessionIds) => seen.push({ hostId, sessionIds }));

      connections(registry).get("box")!.reportDaemonReplacing(["pane-a"]);

      expect(seen).toEqual([{ hostId: "box", sessionIds: ["pane-a"] }]);
    });

    it("routes a remote backend's onDaemonReplacing to its host's event", () => {
      const { registry, replacing } = setup();
      registry.register("box", box);
      const seen: Array<{ hostId: string; sessionIds: string[] }> = [];
      registry.onDaemonReplacing((hostId, sessionIds) => seen.push({ hostId, sessionIds }));

      replacing.get("box")!(["pane-a", "pane-b"]);

      expect(seen).toEqual([{ hostId: "box", sessionIds: ["pane-a", "pane-b"] }]);
    });

    it("reportDaemonReplacing reports for the named host, and ignores an unknown one", () => {
      const { registry } = setup();
      const seen: Array<{ hostId: string; sessionIds: string[] }> = [];
      registry.onDaemonReplacing((hostId, sessionIds) => seen.push({ hostId, sessionIds }));

      registry.reportDaemonReplacing("local", ["pane-1"]);
      registry.reportDaemonReplacing("nowhere", ["pane-x"]);

      expect(seen).toEqual([{ hostId: "local", sessionIds: ["pane-1"] }]);
    });

    it("stops delivering once unsubscribed", () => {
      const { registry } = setup();
      const seen: string[][] = [];
      const off = registry.onDaemonReplacing((_hostId, sessionIds) => seen.push(sessionIds));
      off();

      connections(registry).get("local")!.reportDaemonReplacing(["pane-1"]);

      expect(seen).toEqual([]);
    });
  });
});

describe("provider lifecycle (ADR-229 D1)", () => {
  /** A registry with one remote host, `box`, whose provider can stop it. */
  function lifecycleSetup(opts: { canStop?: boolean } = {}) {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    const provider = {
      ...fakeProvider(),
      capabilities: { canStop: opts.canStop ?? true, canDestroy: false, autoSleep: false },
      stop: vi.fn(async () => {}),
    };
    let beforeReconnect: ((attempt: number) => Promise<boolean>) | undefined;
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => provider as unknown as HostProvider,
      createRemote: (_hostId, _spec: HostSpec, factoryOpts) => {
        beforeReconnect = factoryOpts.beforeReconnect;
        return remote.backend;
      },
    });
    registry.register("box", box);
    const asleep = () => provider.status.mockResolvedValue({ state: "sleeping" });
    return {
      registry,
      remote,
      provider,
      asleep,
      beforeReconnect: (attempt = 0) => beforeReconnect!(attempt),
    };
  }

  /**
   * A registry with one recipe host, `pod`, whose every `up` says the box is
   * at the next address in `addresses` (ADR-230 D2). `reached()` is where
   * the backend's transport would dial now.
   */
  function recipeSetup(addresses: string[] = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
    const local = fakeBackend("local");
    const remote = fakeBackend("pod");
    let ups = 0;
    let reached: string | null = null;
    const provider = {
      ...fakeProvider(),
      kind: "recipe" as const,
      ensureUp: vi.fn(async (_onProgress?: (line: string) => void) => {
        reached = addresses[ups++] ?? null;
      }),
      // Re-runs `up` unless that might wake a box that put itself to sleep.
      refresh: vi.fn(async (onProgress?: (line: string) => void) => {
        await provider.ensureUp(onProgress);
        return true;
      }),
    };
    let beforeReconnect: ((attempt: number) => Promise<boolean>) | undefined;
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => provider as unknown as HostProvider,
      createRemote: (_hostId, _spec: HostSpec, factoryOpts) => {
        beforeReconnect = factoryOpts.beforeReconnect;
        return remote.backend;
      },
    });
    registry.register("pod", { kind: "recipe", recipeId: "k8s-dev" });
    const drop = () =>
      remote.hostEvent({ type: "hostDisconnected", sessionIds: ["pane-a"], retryInMs: 1000 });
    return {
      registry,
      remote,
      provider,
      drop,
      reached: () => reached,
      beforeReconnect: (attempt: number) => beforeReconnect!(attempt),
    };
  }

  describe("a recipe host re-runs up once per drop (ADR-230 D2)", () => {
    it("finds a box that came back at a new address", async () => {
      const { registry, remote, provider, drop, reached, beforeReconnect } = recipeSetup();
      await registry.ensureConnected("pod");
      expect(reached()).toBe("10.0.0.1");
      drop();

      for (const attempt of [0, 1, 2]) await expect(beforeReconnect(attempt)).resolves.toBe(true);

      expect(provider.ensureUp).toHaveBeenCalledTimes(2);
      expect(reached()).toBe("10.0.0.2");
      expect(registry.status("pod")).toBe("reconnecting");
      remote.hostEvent({ type: "hostReconnected", sessionIds: ["pane-a"] });
      expect(registry.status("pod")).toBe("connected");
    });

    it("runs up once per drop, and not before the third attempt", async () => {
      const { registry, remote, provider, drop, beforeReconnect } = recipeSetup();
      await registry.ensureConnected("pod");
      drop();

      await beforeReconnect(0);
      await beforeReconnect(1);
      expect(provider.ensureUp).toHaveBeenCalledTimes(1);
      await beforeReconnect(2);
      await beforeReconnect(3);
      await beforeReconnect(4);
      expect(provider.ensureUp).toHaveBeenCalledTimes(2);

      // Back, then dropped again: a new drop gets its own re-run.
      remote.hostEvent({ type: "hostReconnected", sessionIds: ["pane-a"] });
      drop();
      await beforeReconnect(0);
      await beforeReconnect(1);
      expect(provider.ensureUp).toHaveBeenCalledTimes(2);
      await beforeReconnect(2);
      expect(provider.ensureUp).toHaveBeenCalledTimes(3);
    });

    it("does not run up for a box that may have put itself to sleep", async () => {
      const { registry, provider, drop, beforeReconnect } = recipeSetup();
      // The recipe is autoSleep with no `status`: the provider declines.
      provider.refresh.mockResolvedValue(false);
      await registry.ensureConnected("pod");
      drop();

      for (const attempt of [0, 1, 2, 3]) await expect(beforeReconnect(attempt)).resolves.toBe(true);

      expect(provider.refresh).toHaveBeenCalledTimes(1);
      expect(provider.ensureUp).toHaveBeenCalledTimes(1);
      expect(registry.status("pod")).toBe("reconnecting");
    });

    it("does not re-run up for a box that is asleep", async () => {
      const { registry, provider, drop, beforeReconnect } = recipeSetup();
      await registry.ensureConnected("pod");
      drop();
      provider.status.mockResolvedValue({ state: "sleeping" });

      await expect(beforeReconnect(2)).resolves.toBe(false);

      expect(provider.refresh).not.toHaveBeenCalled();
      expect(registry.status("pod")).toBe("sleeping");
    });

    it("keeps redialling when up fails, without failing the host", async () => {
      const { registry, provider, drop, beforeReconnect } = recipeSetup();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await registry.ensureConnected("pod");
      drop();
      provider.ensureUp.mockRejectedValueOnce(new Error("quota exceeded"));

      for (const attempt of [0, 1, 2, 3]) await expect(beforeReconnect(attempt)).resolves.toBe(true);

      expect(provider.ensureUp).toHaveBeenCalledTimes(2);
      expect(registry.status("pod")).toBe("reconnecting");
      warn.mockRestore();
    });

    it("shows up's progress while reconnecting", async () => {
      const { registry, provider, drop, beforeReconnect } = recipeSetup();
      await registry.ensureConnected("pod");
      drop();
      let shown: string | undefined;
      provider.ensureUp.mockImplementationOnce(async (onProgress) => {
        onProgress?.("Resuming the pod…");
        shown = registry.list()[1].progress;
      });

      await beforeReconnect(2);

      expect(shown).toBe("Resuming the pod…");
      expect(registry.status("pod")).toBe("reconnecting");
    });
  });

  it("brings the box up before the backend connects, showing its progress", async () => {
    const { registry, remote, provider } = lifecycleSetup();
    const order: string[] = [];
    let shown: string | undefined;
    provider.ensureUp.mockImplementation(async (onProgress) => {
      order.push("ensureUp");
      onProgress?.("Starting the pod…");
      shown = registry.list()[1].progress;
    });
    remote.raw.connect.mockImplementation(async () => {
      order.push("connect");
    });

    await registry.ensureConnected("box");

    expect(order).toEqual(["ensureUp", "connect"]);
    expect(shown).toBe("Starting the pod…");
    expect(registry.status("box")).toBe("connected");
  });

  it("fails the connect when the box cannot be brought up, without connecting", async () => {
    const { registry, remote, provider } = lifecycleSetup();
    provider.ensureUp.mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(registry.ensureConnected("box")).rejects.toThrow("quota exceeded");

    expect(remote.raw.connect).not.toHaveBeenCalled();
    expect(registry.list()[1]).toMatchObject({ status: "error", error: "quota exceeded" });
  });

  it("stops reconnecting once the box is asleep, and leaves it asleep for pollers", async () => {
    const { registry, remote, provider, asleep, beforeReconnect } = lifecycleSetup();
    await registry.ensureConnected("box");
    remote.hostEvent({ type: "hostDisconnected", sessionIds: ["pane-a"], retryInMs: 1000 });
    expect(registry.status("box")).toBe("reconnecting");

    // While the box is up, the loop goes on.
    await expect(beforeReconnect()).resolves.toBe(true);
    expect(registry.status("box")).toBe("reconnecting");

    asleep();
    await expect(beforeReconnect()).resolves.toBe(false);
    expect(registry.status("box")).toBe("sleeping");
    expect(provider.dispose).toHaveBeenCalled();

    // Neither a background connect nor a poller's git call wakes it.
    registry.connectInBackground("box");
    await expect(registry.get("box").git.exec("/p", ["status"])).rejects.toBeInstanceOf(
      HostUnavailableError,
    );
    // Nor does a pty call on its own: waking is the router's, for a call that means it.
    await expect(registry.get("box").pty.listSessions()).rejects.toBeInstanceOf(
      HostUnavailableError,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(remote.raw.connect).toHaveBeenCalledTimes(1);
    expect(provider.ensureUp).toHaveBeenCalledTimes(1);
    expect(registry.status("box")).toBe("sleeping");
  });

  it("wakes a sleeping host on wake(), bringing the box up and connecting", async () => {
    const { registry, remote, provider, asleep, beforeReconnect } = lifecycleSetup();
    await registry.ensureConnected("box");
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    asleep();
    await beforeReconnect();
    expect(registry.status("box")).toBe("sleeping");

    await registry.wake("box");

    expect(provider.ensureUp).toHaveBeenCalledTimes(2);
    expect(remote.raw.connect).toHaveBeenCalledTimes(2);
    expect(registry.status("box")).toBe("connected");
  });

  it("leaves a box it finds asleep asleep on a background connect", async () => {
    const { registry, remote, provider, asleep } = lifecycleSetup();
    asleep();

    registry.connectInBackground("box");
    await vi.waitFor(() => expect(registry.status("box")).toBe("sleeping"));

    expect(provider.ensureUp).not.toHaveBeenCalled();
    expect(remote.raw.connect).not.toHaveBeenCalled();

    // A connect somebody means wakes it.
    await registry.ensureConnected("box");
    expect(provider.ensureUp).toHaveBeenCalledTimes(1);
    expect(registry.status("box")).toBe("connected");
  });

  it("stop() disconnects, has the provider stop the box, and sleeps", async () => {
    const { registry, remote, provider } = lifecycleSetup();
    await registry.ensureConnected("box");

    await registry.stop("box");

    expect(remote.raw.disconnect).toHaveBeenCalled();
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(registry.status("box")).toBe("sleeping");
    // A disconnect (app quit) keeps it asleep.
    await registry.disconnect("box");
    expect(registry.status("box")).toBe("sleeping");
  });

  it("refuses to stop a box its provider cannot stop", async () => {
    const { registry, provider } = lifecycleSetup({ canStop: false });
    await registry.ensureConnected("box");

    await expect(registry.stop("box")).rejects.toThrow("can't be stopped");

    expect(provider.stop).not.toHaveBeenCalled();
    expect(registry.status("box")).toBe("connected");
  });

  it("reports a box deleted outside Manor as missing, and starts it again only on wake (ADR-229 D2)", async () => {
    const { registry, remote, provider } = lifecycleSetup();
    provider.status.mockResolvedValue({ state: "error", detail: "Dev pod no longer exists", missing: true });

    // A background connect does not run `up`, which would create it anew.
    registry.connectInBackground("box");
    await vi.waitFor(() => expect(registry.status("box")).toBe("error"));
    expect(registry.list()[1]).toMatchObject({
      status: "error",
      error: "Dev pod no longer exists",
      missing: true,
    });
    expect(provider.ensureUp).not.toHaveBeenCalled();
    expect(remote.raw.connect).not.toHaveBeenCalled();

    // "Start it again".
    await registry.wake("box");
    expect(provider.ensureUp).toHaveBeenCalledTimes(1);
    expect(registry.status("box")).toBe("connected");
    expect(registry.list()[1]).not.toHaveProperty("missing");
  });

  it("stops reconnecting to a box that went missing (ADR-229 D2)", async () => {
    const { registry, remote, provider, beforeReconnect } = lifecycleSetup();
    await registry.ensureConnected("box");
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    provider.status.mockResolvedValue({ state: "error", detail: "Dev pod no longer exists", missing: true });

    await expect(beforeReconnect()).resolves.toBe(false);

    expect(registry.list()[1]).toMatchObject({ status: "error", missing: true });
    expect(provider.dispose).toHaveBeenCalled();
  });

  it("names a recipe host by its recipe, falling back to the recipe id (ADR-229 D2)", () => {
    const { registry } = setup();
    registry.register("pod", { kind: "recipe", recipeId: "no-such-recipe" });
    expect(registry.list()[1]).toMatchObject({ hostId: "pod", label: "no-such-recipe" });
    expect(registry.hostDisplayName("pod")).toBe("no-such-recipe");
  });

  it("stamps the provider's kind and capabilities on each remote host", () => {
    const { registry } = lifecycleSetup();
    expect(registry.list()[1]).toMatchObject({
      providerKind: "ssh",
      capabilities: { canStop: true, canDestroy: false, autoSleep: false },
    });
    expect(registry.list()[0]).not.toHaveProperty("providerKind");
  });
});

describe("provider lifecycle: a meant connect joining a background one (ADR-229 D1)", () => {
  it("wakes the host once the background attempt has left it asleep", async () => {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    const provider = fakeProvider();
    let answer!: (state: { state: ProviderState }) => void;
    provider.status.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => provider as unknown as HostProvider,
      createRemote: () => remote.backend,
    });
    registry.register("box", box);

    registry.connectInBackground("box");
    const meant = registry.ensureConnected("box");
    answer({ state: "sleeping" });
    await meant;

    expect(provider.ensureUp).toHaveBeenCalledTimes(1);
    expect(registry.status("box")).toBe("connected");
  });
});
