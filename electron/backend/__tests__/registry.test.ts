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
  ControlRelayCommand,
  ScannedPort,
  HostConnectionEvent,
  HostSpec,
  RemoteHostBackend,
  StreamEvent,
  PaneFacts,
} from "../types";
import { SshAuthError } from "../../terminal-host/ssh-config";
import type { HostProvider } from "../providers/types";

/** A WorkspaceBackend whose every call is a spy, plus handles to drive it. */
function fakeBackend(name: string) {
  let streamHandler: ((event: StreamEvent) => void) | null = null;
  const hostHandlers: Array<(event: HostConnectionEvent) => void> = [];
  const streamConnectedHandlers: Array<() => void> = [];
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
      replayHooks: vi.fn(async () => ({ entries: [], lastSeq: 0, epoch: "e0" })),
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
    onStreamConnected: vi.fn((handler: () => void) => {
      streamConnectedHandlers.push(handler);
      return () => {
        const i = streamConnectedHandlers.indexOf(handler);
        if (i >= 0) streamConnectedHandlers.splice(i, 1);
      };
    }),
    sendControlRelayCommand: vi.fn((_cmd: ControlRelayCommand) => true),
  };
  return {
    raw,
    backend: raw as unknown as RemoteHostBackend,
    stream: (event: StreamEvent) => streamHandler?.(event),
    hostEvent: (event: HostConnectionEvent) => {
      for (const h of hostHandlers) h(event);
    },
    /** The backend's stream socket (re)connected. */
    streamConnected: () => {
      for (const h of streamConnectedHandlers) h();
    },
    /** Whether anything is still subscribed to this backend's events. */
    listening: () =>
      streamHandler !== null || hostHandlers.length > 0 || streamConnectedHandlers.length > 0,
  };
}

/** A HostProvider whose every call is a spy. */
function fakeProvider() {
  const provider = {
    kind: "ssh" as const,
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
    expect(registry.list()[1]).toEqual({ hostId: "box", spec: box, status: "disconnected" });
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
    expect(registry.list()[1]).toEqual({ hostId: "box", spec: box, status: "connected" });

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
    expect(registry.list()[1]).toEqual({ hostId: "box", spec: box, status: "disconnected" });

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

describe("BackendRegistry — remote agent hooks (ADR-178 §2)", () => {
  function hookSetup() {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    const replayHooks = vi.fn(async (_sinceSeq: number) => ({
      entries: [{ seq: 1, receivedAt: 0, payload: { tag: "1" } }],
      lastSeq: 1,
      epoch: "e0",
    }));
    (remote.raw.pty as Record<string, unknown>).replayHooks = replayHooks;
    const seqs = new Map<string, number>([["box", 0]]);
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: () => remote.backend,
      hookSeqStore: {
        get: (hostId) => {
          const seq = seqs.get(hostId);
          return seq === undefined ? null : { seq, epoch: "e0" };
        },
        set: (hostId, cursor) => void seqs.set(hostId, cursor.seq),
      },
    });
    const ingested: Array<{ hostId: string; tag: string; replay: boolean }> = [];
    registry.setHookSink({
      ingest: (payload, ctx) => ingested.push({ hostId: ctx.hostId, tag: payload.tag, replay: ctx.replay }),
    });
    registry.register("box", box);
    return { registry, local, remote, replayHooks, seqs, ingested };
  }

  it("replays the journal on connect, then feeds live hookEvents without re-publishing them", async () => {
    const { registry, remote, replayHooks, seqs, ingested } = hookSetup();
    const listener = vi.fn();
    registry.onEvent(listener);

    await registry.ensureConnected("box");
    await vi.waitFor(() => expect(ingested).toHaveLength(1));
    expect(replayHooks).toHaveBeenCalledWith(0);
    expect(ingested[0]).toEqual({ hostId: "box", tag: "1", replay: true });

    remote.stream({ type: "hookEvent", seq: 2, payload: { tag: "2" } });
    expect(ingested[1]).toEqual({ hostId: "box", tag: "2", replay: false });
    expect(seqs.get("box")).toBe(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("holds hooks while reconnecting and catches up once the host is back", async () => {
    const { registry, remote, replayHooks, ingested } = hookSetup();
    await registry.ensureConnected("box");
    await vi.waitFor(() => expect(ingested).toHaveLength(1));

    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    remote.stream({ type: "hookEvent", seq: 3, payload: { tag: "3" } });
    expect(ingested).toHaveLength(1);

    replayHooks.mockResolvedValueOnce({
      entries: [2, 3].map((seq) => ({ seq, receivedAt: 0, payload: { tag: String(seq) } })),
      lastSeq: 3,
      epoch: "e0",
    });
    remote.hostEvent({ type: "hostReconnected", sessionIds: [] });
    await vi.waitFor(() => expect(ingested.map((i) => i.tag)).toEqual(["1", "2", "3"]));
    expect(replayHooks).toHaveBeenLastCalledWith(1);
  });
  it("records the host's sessions before replaying, so replayed hooks relay to the remote daemon", async () => {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    const order: string[] = [];
    remote.raw.pty.listSessions.mockImplementation(async () => {
      order.push("listSessions");
      return [{ sessionId: "pane-remote" }];
    });
    (remote.raw.pty as Record<string, unknown>).replayHooks = vi.fn(async () => {
      order.push("replayHooks");
      return {
        entries: [{ seq: 1, receivedAt: 0, payload: { paneId: "pane-remote" } }],
        lastSeq: 1,
        epoch: "e0",
      };
    });
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: () => remote.backend,
      hookSeqStore: { get: () => ({ seq: 0, epoch: "e0" }), set: () => {} },
    });
    const routed = new RoutedBackend(registry, () => "local");
    // What the hook relay does for each ingested hook: route by pane.
    registry.setHookSink({
      ingest: (payload) => routed.pty.write(payload.paneId, "hook"),
    });
    registry.register("box", box);

    // A fresh launch: nothing has been created or attached on the box yet.
    expect(registry.sessions.ownerOf("pane-remote")).toBeUndefined();
    await registry.ensureConnected("box");
    await vi.waitFor(() => expect(remote.raw.pty.write).toHaveBeenCalled());

    expect(order).toEqual(["listSessions", "replayHooks"]);
    expect(remote.raw.pty.write).toHaveBeenCalledWith("pane-remote", "hook");
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
    const order: string[] = [];
    let releaseReplay: (() => void) | null = null;
    (remote.raw.pty as Record<string, unknown>).replayHooks = vi.fn(async () => {
      order.push("replay-start");
      await new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      order.push("replay-done");
      return { entries: [], lastSeq: 0, epoch: "e0" };
    });
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: () => remote.backend,
      hookSeqStore: { get: () => ({ seq: 0, epoch: "e0" }), set: () => {} },
    });
    registry.setHookSink({ ingest: () => {} });
    registry.register("box", box);
    const resumed: Array<{ hostId: string; sessionIds: string[] }> = [];
    registry.onHostResumed((hostId, sessionIds) => {
      order.push("resumed");
      resumed.push({ hostId, sessionIds });
    });
    return { registry, remote, order, resumed, release: () => releaseReplay?.() };
  }

  it("announces a resumed host only after its hook replay, with every live session", async () => {
    const { registry, remote, order, resumed, release } = resumeSetup();
    await registry.ensureConnected("box");
    await vi.waitFor(() => expect(order).toContain("replay-start"));
    release();
    await vi.waitFor(() => expect(order).toContain("replay-done"));
    order.length = 0;
    // The initial connect is not a reconnect: nothing to reattach.
    expect(resumed).toEqual([]);

    remote.raw.pty.listSessions.mockResolvedValue([{ sessionId: "pane-a" }]);
    remote.hostEvent({ type: "hostDisconnected", sessionIds: ["pane-a", "pane-b"], retryInMs: 1000 });
    remote.hostEvent({ type: "hostReconnected", sessionIds: ["pane-a"] });
    await vi.waitFor(() => expect(order).toContain("replay-start"));
    await new Promise((r) => setTimeout(r, 10));
    expect(resumed).toEqual([]);

    release();
    await vi.waitFor(() => expect(resumed).toHaveLength(1));
    expect(order).toEqual(["replay-start", "replay-done", "resumed"]);
    expect(resumed[0]).toEqual({ hostId: "box", sessionIds: ["pane-a"] });
  });

  it("drops the announcement when the host drops again before its replay is in", async () => {
    const { registry, remote, resumed, release } = resumeSetup();
    await registry.ensureConnected("box");
    release();
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    remote.hostEvent({ type: "hostReconnected", sessionIds: [] });
    remote.hostEvent({ type: "hostDisconnected", sessionIds: [], retryInMs: 1000 });
    release();
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

describe("BackendRegistry — control relay (ADR-189 §2)", () => {
  function relaySetup() {
    const local = fakeBackend("local");
    const remote = fakeBackend("box");
    const registry = new BackendRegistry({
      local: local.backend,
      remoteVersion: "0.1.0",
      createProvider: () => fakeProvider() as unknown as HostProvider,
      createRemote: () => remote.backend,
    });
    registry.register("box", box);
    const request = (id: string) =>
      remote.stream({ type: "controlRequest", id, method: "GET", path: "/context?cwd=/x", body: undefined });
    return { registry, local, remote, request };
  }

  it("asks for relayed requests on every stream (re)connect", () => {
    const { remote } = relaySetup();
    expect(remote.raw.sendControlRelayCommand).not.toHaveBeenCalled();
    remote.streamConnected();
    remote.streamConnected();
    expect(remote.raw.sendControlRelayCommand.mock.calls).toEqual([
      [{ type: "enableControlRelay" }],
      [{ type: "enableControlRelay" }],
    ]);
  });

  it("answers a request through the sink, tagged with the host, and does not re-publish it", async () => {
    const { registry, remote, request } = relaySetup();
    const listener = vi.fn();
    registry.onEvent(listener);
    const sink = vi.fn(async () => ({ status: 200, body: { projectId: "p1" } }));
    registry.setControlRelaySink(sink);

    request("r1");
    await vi.waitFor(() =>
      expect(remote.raw.sendControlRelayCommand).toHaveBeenCalledWith({
        type: "controlResponse",
        id: "r1",
        status: 200,
        body: { projectId: "p1" },
      }),
    );
    expect(sink).toHaveBeenCalledWith("box", {
      method: "GET",
      path: "/context?cwd=/x",
      body: undefined,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("answers 503 with no sink and 500 when the sink throws", async () => {
    const { registry, remote, request } = relaySetup();
    request("r1");
    await vi.waitFor(() =>
      expect(remote.raw.sendControlRelayCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: "controlResponse", id: "r1", status: 503 }),
      ),
    );

    registry.setControlRelaySink(async () => {
      throw new Error("boom");
    });
    request("r2");
    await vi.waitFor(() =>
      expect(remote.raw.sendControlRelayCommand).toHaveBeenCalledWith({
        type: "controlResponse",
        id: "r2",
        status: 500,
        body: { error: "boom" },
      }),
    );
  });

  it("stops asking once the host is unregistered", async () => {
    const { registry, remote } = relaySetup();
    await registry.unregister("box");
    remote.streamConnected();
    expect(remote.raw.sendControlRelayCommand).not.toHaveBeenCalled();
  });
});
