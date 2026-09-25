import { describe, it, expect, vi } from "vitest";
import {
  BackendRegistry,
  HostUnavailableError,
  type HostStatusInfo,
} from "../registry";
import { RoutedBackend } from "../routed-backend";
import type {
  ActivePort,
  HostConnectionEvent,
  HostSpec,
  StreamEvent,
  WorkspaceBackend,
} from "../types";
import { SshAuthError } from "../../terminal-host/ssh-config";

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
      listSessions: vi.fn(async () => [] as Array<{ sessionId: string }>),
      disposeDead: vi.fn(async () => {}),
      onEvent: vi.fn((handler: (event: StreamEvent) => void) => {
        streamHandler = handler;
      }),
      updateEnv: vi.fn(async () => {}),
      relayAgentHook: vi.fn(),
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
      scan: vi.fn(async (): Promise<ActivePort[]> => []),
      kill: vi.fn(async () => {}),
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    onHostEvent: vi.fn((handler: (event: HostConnectionEvent) => void) => {
      hostHandlers.push(handler);
    }),
  };
  return {
    raw,
    backend: raw as unknown as WorkspaceBackend,
    stream: (event: StreamEvent) => streamHandler?.(event),
    hostEvent: (event: HostConnectionEvent) => {
      for (const h of hostHandlers) h(event);
    },
  };
}

function setup() {
  const local = fakeBackend("local");
  const remotes = new Map<string, ReturnType<typeof fakeBackend>>();
  const progress = new Map<string, (message: string) => void>();
  const registry = new BackendRegistry({
    local: local.backend,
    version: "1.2.3",
    createRemote: (hostId, _spec: HostSpec, opts) => {
      const fake = fakeBackend(hostId);
      remotes.set(hostId, fake);
      progress.set(hostId, (message) =>
        opts.onBootstrapProgress({ phase: "install", target: hostId, message }),
      );
      return fake.backend;
    },
  });
  return { registry, local, remotes, progress };
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
    expect(local.raw.connect).toHaveBeenCalledWith({ version: "1.2.3" });
    expect(registry.status("local")).toBe("connected");
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
    expect(registry.hostForSession("pane-a")).toBe("box");

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

  it("waits for the connection before a pty call", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const remote = remotes.get("box")!;
    await registry.get("box").pty.createOrAttach("pane-1", "/r", 80, 24);
    expect(remote.raw.connect).toHaveBeenCalledTimes(1);
    expect(remote.raw.pty.createOrAttach).toHaveBeenCalledWith("pane-1", "/r", 80, 24);
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
    expect(registry.hostForSession("pane-r")).toBe("box");
  });

  it("ignores a replaced host's old backend", async () => {
    const { registry, remotes } = setup();
    registry.register("box", box);
    const old = remotes.get("box")!;
    registry.register("box", { kind: "ssh", target: "me@other" });
    expect(old.raw.disconnect).toHaveBeenCalled();
    old.hostEvent({ type: "hostReconnected", sessionIds: [] });
    expect(registry.status("box")).toBe("disconnected");
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

  it("creates a pane on the host its cwd belongs to, then routes the pane there", async () => {
    const { backend, local, box: remote } = routed();
    await backend.pty.createOrAttach("pane-r", "/remote/app", 80, 24);
    await backend.pty.createOrAttach("pane-l", "/Users/me/app", 80, 24);
    expect(remote.raw.pty.createOrAttach).toHaveBeenCalledWith(
      "pane-r", "/remote/app", 80, 24, undefined,
    );
    expect(local.raw.pty.createOrAttach).toHaveBeenCalledWith(
      "pane-l", "/Users/me/app", 80, 24, undefined,
    );

    backend.pty.write("pane-r", "ls\n");
    await backend.pty.resize("pane-r", 100, 30);
    backend.pty.relayAgentHook("pane-r", "working", "claude");
    expect(remote.raw.pty.write).toHaveBeenCalledWith("pane-r", "ls\n");
    expect(remote.raw.pty.resize).toHaveBeenCalledWith("pane-r", 100, 30);
    expect(remote.raw.pty.relayAgentHook).toHaveBeenCalledWith("pane-r", "working", "claude");
    expect(local.raw.pty.write).not.toHaveBeenCalled();

    // Unknown panes are local, as every pane was before hosts.
    backend.pty.write("pane-x", "y");
    expect(local.raw.pty.write).toHaveBeenCalledWith("pane-x", "y");
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
    expect(registry.hostForSession("pane-r")).toBe("box");

    remote.raw.pty.listSessions.mockRejectedValueOnce(new Error("ssh died"));
    expect((await backend.pty.listSessions()).map((s) => s.sessionId)).toEqual(["pane-l"]);
  });

  it("scans ports per host and kills a pid on the host that reported it", async () => {
    const { backend, registry, local, box: remote } = routed();
    await registry.ensureConnected("box");
    const port = (pid: number): ActivePort => ({
      port: 3000,
      processName: "node",
      pid,
      workspacePath: null,
      hostname: null,
    });
    local.raw.ports.scan.mockResolvedValue([port(1)]);
    remote.raw.ports.scan.mockResolvedValue([port(2)]);

    const ports = await backend.ports.scan(["/Users/me/app", "/remote/app"]);
    expect(local.raw.ports.scan).toHaveBeenCalledWith(["/Users/me/app"]);
    expect(remote.raw.ports.scan).toHaveBeenCalledWith(["/remote/app"]);
    expect(ports).toEqual([port(1), { ...port(2), hostId: "box" }]);

    await backend.ports.kill(2);
    expect(remote.raw.ports.kill).toHaveBeenCalledWith(2);
    await backend.ports.kill(1);
    expect(local.raw.ports.kill).toHaveBeenCalledWith(1);
  });

  it("with only the local host, passes every call straight to it", async () => {
    const local = fakeBackend("local");
    const registry = new BackendRegistry({ local: local.backend });
    const backend = new RoutedBackend(registry, () => "local");
    await backend.pty.createOrAttach("pane-1", "/anywhere", 80, 24);
    await backend.ports.scan(["/a", "/b"]);
    await backend.shell.which("git");
    expect(local.raw.pty.createOrAttach).toHaveBeenCalledWith(
      "pane-1", "/anywhere", 80, 24, undefined,
    );
    expect(local.raw.ports.scan).toHaveBeenCalledWith(["/a", "/b"]);
    expect(local.raw.shell.which).toHaveBeenCalledWith("git");
  });
});
