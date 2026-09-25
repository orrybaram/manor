import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock electron ──────────────────────────────────────────────────────────────
const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
  },
}));

// ── Mock the portless proxy ────────────────────────────────────────────────────
const updateRoutes = vi.fn();

vi.mock("../portless", () => ({
  portlessManager: {
    get proxyPort() {
      return 7999;
    },
    updateRoutes: (routes: unknown) => updateRoutes(routes),
    hostnameForPort: (
      _path: string,
      projectName: string | null,
      branch: string | null,
      isMain: boolean,
    ) =>
      branch && !isMain
        ? `${branch}.${projectName}.localhost`
        : `${projectName}.localhost`,
  },
}));

vi.mock("../ipc-validate", () => ({
  assertPositiveInt: vi.fn(),
  assertString: vi.fn(),
  assertStringArray: vi.fn(),
}));

import { register } from "../ipc/ports";
import type { WorkspaceMeta } from "../ipc/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function meta(overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  return {
    path: "/repo",
    projectName: "acme",
    branch: null,
    isMain: true,
    portlessEnabled: true,
    ...overrides,
  };
}

/** `scanNow` returns fresh objects per scan, as the real scanner does. */
function makeDeps(
  workspaceMeta: WorkspaceMeta[],
  scanned: {
    port: number;
    workspacePath: string;
    hostId?: string;
    loopbackHost?: "::1";
  }[] = [
    { port: 3000, workspacePath: "/repo" },
  ],
  forwarded: Map<string, number> = new Map(),
) {
  const changeListeners: (() => void)[] = [];
  const statusListeners: (() => void)[] = [];
  const hostScanListeners: ((hostId: string) => void)[] = [];
  /** Remote host statuses; unlisted hosts are unregistered. */
  const statuses = new Map<string, string>([["box", "connected"]]);
  /** Hosts the poller has scanned. */
  const scannedHosts = new Set<string>(["box"]);
  let urlResolver: ((url: string, hostId: string) => Promise<string>) | null = null;
  return {
    backendRegistry: {
      provider: () => undefined,
      status: (hostId: string) => statuses.get(hostId),
      onStatusChange: (listener: () => void) => {
        statusListeners.push(listener);
        return () => {};
      },
    },
    /** Test controls for host readiness. */
    host: {
      setStatus(hostId: string, status: string | undefined) {
        if (status === undefined) statuses.delete(hostId);
        else statuses.set(hostId, status);
        for (const l of statusListeners) l();
      },
      setScanned(hostId: string, scanned: boolean) {
        if (scanned) scannedHosts.add(hostId);
        else scannedHosts.delete(hostId);
        if (scanned) for (const l of hostScanListeners) l(hostId);
      },
    },
    webviewServer: {
      setRemoteUrlResolver: (r: (url: string, hostId: string) => Promise<string>) => {
        urlResolver = r;
      },
      resolve: (url: string, hostId: string) => urlResolver!(url, hostId),
    },
    /** Live forwards keyed `${hostId}:${remotePort}`. */
    remoteForwards: {
      localPort: (hostId: string, port: number) => forwarded.get(`${hostId}:${port}`),
      remotePortFor: (hostId: string, localPort: number) => {
        for (const [key, local] of forwarded) {
          const [h, remote] = key.split(":");
          if (h === hostId && local === localPort) return Number(remote);
        }
        return undefined;
      },
      ensure: vi.fn(async (hostId: string, port: number, _opts?: { remoteHost?: string }) => {
        const local = 50000 + port;
        forwarded.set(`${hostId}:${port}`, local);
        for (const l of changeListeners) l();
        return local;
      }),
      onChange: (listener: () => void) => {
        changeListeners.push(listener);
        return () => {};
      },
    },
    portScanner: {
      start: vi.fn(),
      stop: vi.fn(),
      updateWorkspacePaths: vi.fn(),
      hasScanned: (hostId: string) => scannedHosts.has(hostId),
      onHostScanned: (listener: (hostId: string) => void) => {
        hostScanListeners.push(listener);
        return () => {};
      },
      scanNow: vi
        .fn()
        .mockImplementation(async () =>
          scanned.map((p, i) => ({ ...p, pid: i + 1 })),
        ),
    },
    backend: { ports: { kill: vi.fn() } },
    mainWindow: null,
    workspaceMeta,
  };
}

async function scan() {
  return (await handlers.get("ports:scanNow")!()) as {
    port: number;
    hostname?: string;
  }[];
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("portless per-project gate", () => {
  beforeEach(() => {
    handlers.clear();
    updateRoutes.mockClear();
  });

  it("assigns a named hostname and a proxy route when enabled", async () => {
    register(makeDeps([meta()]) as never);

    const ports = await scan();

    expect(ports[0].hostname).toBe("acme.localhost:7999");
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "acme.localhost", port: 3000 },
    ]);
  });

  it("leaves the port on plain localhost and registers no route when disabled", async () => {
    register(makeDeps([meta({ portlessEnabled: false })]) as never);

    const ports = await scan();

    expect(ports[0].hostname).toBeUndefined();
    expect(updateRoutes).toHaveBeenLastCalledWith([]);
  });

  /** A workspace from a project persisted before the flag existed. */
  it("treats a missing portlessEnabled as enabled", async () => {
    const legacy = meta();
    delete (legacy as Partial<WorkspaceMeta>).portlessEnabled;
    register(makeDeps([legacy]) as never);

    const ports = await scan();

    expect(ports[0].hostname).toBe("acme.localhost:7999");
  });

  it("drops the hostname and the route once the toggle is flipped off", async () => {
    register(makeDeps([meta()]) as never);
    expect((await scan())[0].hostname).toBe("acme.localhost:7999");

    // What the renderer pushes when the settings switch changes.
    handlers.get("ports:updateWorkspaceMetadata")!({} as never, [
      meta({ portlessEnabled: false }),
    ]);

    const ports = await scan();
    expect(ports[0].hostname).toBeUndefined();
    expect(updateRoutes).toHaveBeenLastCalledWith([]);
  });

  it("gates per project — a disabled project does not affect an enabled one", async () => {
    register(
      makeDeps(
        [
          meta(),
          meta({ path: "/other", projectName: "other", portlessEnabled: false }),
        ],
        [
          { port: 3000, workspacePath: "/repo" },
          { port: 4000, workspacePath: "/other" },
        ],
      ) as never,
    );

    const ports = await scan();

    expect(ports.find((p) => p.port === 3000)!.hostname).toBe(
      "acme.localhost:7999",
    );
    expect(ports.find((p) => p.port === 4000)!.hostname).toBeUndefined();
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "acme.localhost", port: 3000 },
    ]);
  });
});

describe("remote ports", () => {
  beforeEach(() => {
    handlers.clear();
    updateRoutes.mockClear();
  });

  const remoteScan = [
    { port: 3000, workspacePath: "/repo", hostId: "box" },
    { port: 4000, workspacePath: "/local" },
  ];

  it("routes a remote port only once it is forwarded, then to the forward", async () => {
    const deps = makeDeps(
      [meta(), meta({ path: "/local", projectName: "loc" })],
      remoteScan,
    );
    register(deps as never);

    const ports = await scan();
    // The hostname is shown either way; the route waits for the forward.
    expect(ports.find((p) => p.port === 3000)!.hostname).toBe("acme.localhost:7999");
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "loc.localhost", port: 4000 },
    ]);

    // Opening the portless URL makes the forward, which re-routes.
    const url = await handlers.get("ports:resolveUrl")!(
      {} as never,
      "http://acme.localhost:7999/",
      "box",
    );
    expect(url).toBe("http://acme.localhost:7999/");
    expect(deps.remoteForwards.ensure).toHaveBeenCalledWith("box", 3000, {
      remoteHost: undefined,
    });
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "acme.localhost", port: 53000 },
      { hostname: "loc.localhost", port: 4000 },
    ]);
  });

  it("rewrites a reported remote port to its forward, and nothing else", async () => {
    const deps = makeDeps([], remoteScan);
    register(deps as never);
    await scan();
    const resolve = (url: string, hostId: string) =>
      handlers.get("ports:resolveUrl")!({} as never, url, hostId);

    // On 127.0.0.1, where the forward listens.
    expect(await resolve("http://localhost:3000/app?x=1", "box")).toBe(
      "http://127.0.0.1:53000/app?x=1",
    );
    // Not reported by that host's scan: may be this machine's.
    expect(await resolve("http://localhost:4000/", "box")).toBe("http://localhost:4000/");
    // This machine never rewrites.
    expect(await resolve("http://localhost:3000/", "local")).toBe("http://localhost:3000/");
    expect(deps.remoteForwards.ensure).toHaveBeenCalledTimes(1);
  });

  it("hands the URL back unchanged when the forward cannot be made", async () => {
    const deps = makeDeps([], remoteScan);
    deps.remoteForwards.ensure.mockRejectedValueOnce(new Error("not connected"));
    register(deps as never);
    await scan();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      await handlers.get("ports:resolveUrl")!({} as never, "http://localhost:3000/", "box"),
    ).toBe("http://localhost:3000/");
    warn.mockRestore();
  });

  it("forwards to [::1] for a port the scan saw only there", async () => {
    const deps = makeDeps([], [
      { port: 3000, workspacePath: "/repo", hostId: "box", loopbackHost: "::1" },
    ]);
    register(deps as never);
    await scan();
    await handlers.get("ports:resolveUrl")!({} as never, "http://[::1]:3000/", "box");
    expect(deps.remoteForwards.ensure).toHaveBeenCalledWith("box", 3000, { remoteHost: "::1" });
  });

  it("waits for the host to connect and be scanned before resolving", async () => {
    const deps = makeDeps([], remoteScan);
    deps.host.setStatus("box", "reconnecting");
    deps.host.setScanned("box", false);
    register(deps as never);
    await scan();

    let result: string | undefined;
    void (
      handlers.get("ports:resolveUrl")!({} as never, "http://localhost:3000/", "box") as Promise<string>
    ).then((r) => (result = r));
    await new Promise((r) => setTimeout(r, 0));
    expect(result).toBeUndefined();

    deps.host.setStatus("box", "connected");
    await new Promise((r) => setTimeout(r, 0));
    expect(result).toBeUndefined(); // connected, but not scanned yet

    deps.host.setScanned("box", true);
    await vi.waitFor(() => expect(result).toBe("http://127.0.0.1:53000/"));
  });

  it("does not wait on the host for URLs that cannot be its", async () => {
    const deps = makeDeps([], remoteScan);
    deps.host.setStatus("box", "reconnecting");
    register(deps as never);
    expect(
      await handlers.get("ports:resolveUrl")!({} as never, "https://example.com/", "box"),
    ).toBe("https://example.com/");
  });

  it("hands the URL back when the host is unregistered while waiting", async () => {
    const deps = makeDeps([], remoteScan);
    deps.host.setStatus("box", "connecting");
    register(deps as never);
    const pending = handlers.get("ports:resolveUrl")!(
      {} as never,
      "http://localhost:3000/",
      "box",
    );
    deps.host.setStatus("box", undefined);
    expect(await pending).toBe("http://localhost:3000/");
  });

  it("normalizes a URL still on a forward's local port", async () => {
    const deps = makeDeps([], remoteScan);
    register(deps as never);
    await scan();
    const resolve = (url: string) =>
      handlers.get("ports:resolveUrl")!({} as never, url, "box") as Promise<string>;
    await resolve("http://localhost:3000/");
    // 53000 is 3000's forward: it resolves back onto the (same) forward.
    expect(await resolve("http://127.0.0.1:53000/x")).toBe("http://127.0.0.1:53000/x");
    expect(deps.remoteForwards.ensure).toHaveBeenLastCalledWith("box", 3000, {
      remoteHost: undefined,
    });
  });

  it("maps a forwarded URL back to the box's localhost for remembering", async () => {
    const deps = makeDeps([], remoteScan);
    register(deps as never);
    await scan();
    await handlers.get("ports:resolveUrl")!({} as never, "http://localhost:3000/", "box");
    const remoteUrl = (url: string, hostId: string) =>
      handlers.get("ports:remoteUrl")!({} as never, url, hostId);
    expect(remoteUrl("http://127.0.0.1:53000/a?b#c", "box")).toBe("http://localhost:3000/a?b#c");
    expect(remoteUrl("http://127.0.0.1:53000/", "other")).toBe("http://127.0.0.1:53000/");
    expect(remoteUrl("http://127.0.0.1:53000/", "local")).toBe("http://127.0.0.1:53000/");
    expect(remoteUrl("http://localhost:8080/", "box")).toBe("http://localhost:8080/");
  });

  it("gives an agent's navigate the same rewrite, bounded by a timeout", async () => {
    const deps = makeDeps([], remoteScan);
    register(deps as never);
    await scan();
    expect(await deps.webviewServer.resolve("http://localhost:3000/", "box")).toBe(
      "http://127.0.0.1:53000/",
    );

    vi.useFakeTimers();
    try {
      deps.host.setStatus("box", "disconnected");
      const pending = deps.webviewServer.resolve("http://localhost:3000/", "box");
      const assertion = expect(pending).rejects.toThrow(/not connected/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
