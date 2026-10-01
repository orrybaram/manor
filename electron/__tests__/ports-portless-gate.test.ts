import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock the portless proxy ────────────────────────────────────────────────────
const updateRoutes = vi.fn();

vi.mock("../portless", () => ({
  portlessManager: {
    get proxyPort() {
      return 7999;
    },
    updateRoutes: (routes: unknown) => updateRoutes(routes),
  },
}));

vi.mock("../ipc-validate", () => ({
  assertHostPaths: vi.fn(),
  assertPositiveInt: vi.fn(),
  assertString: vi.fn(),
  assertWorkspaceMeta: vi.fn(),
}));

import {
  installPortEnricher,
  portsRemoteUrl,
  portsResolveUrl,
  portsScanNow,
  portsUpdateWorkspaceMetadata,
} from "../bridge/handlers/ports";
import { RemoteUrlResolver } from "../remote-forwards";
import type { WorkspaceMeta } from "../ipc/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * The deps the handlers under test run over. There is no `register()` any
 * more (ADR-180 D8): the handler table calls the lifted functions with the
 * one long-lived `IpcDeps`, and `installPortEnricher` is the boot-time half
 * of what `register()` used to do.
 */
let current: never;
function register(deps: never): void {
  current = deps;
  installPortEnricher(deps);
}

function meta(overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  return {
    path: "/repo",
    hostId: "local",
    projectName: "acme",
    branch: null,
    isMain: true,
    portlessEnabled: true,
    ...overrides,
  };
}

/**
 * A scan returns fresh objects tagged with their host ("local" unless
 * given), dressed by the enricher `bridge/handlers/ports` installs — as the real
 * scanner does.
 */
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
  /** Registered remote hosts, for their hostname segments. */
  remoteHostIds: string[] = ["box"],
) {
  const changeListeners: (() => void)[] = [];
  const statusListeners: (() => void)[] = [];
  const hostScanListeners: ((hostId: string) => void)[] = [];
  /** Remote host statuses; unlisted hosts are unregistered. */
  const statuses = new Map<string, string>([["box", "connected"]]);
  /** Hosts the poller has scanned. */
  const scannedHosts = new Set<string>(["box"]);
  type Port = { port: number; workspacePath: string; hostId: string; pid: number };
  let enrich = (ports: Port[]) => ports;
  let results: Port[] = [];
  let latest: Port[] = [];
  const scanAndPublish = async () => {
    results = scanned.map((p, i) => ({ ...p, hostId: p.hostId ?? "local", pid: i + 1 }));
    latest = enrich(results);
    return latest;
  };

  const backendRegistry = {
    provider: () => undefined,
    remoteHostIds: () => remoteHostIds,
    status: (hostId: string) => statuses.get(hostId),
    onStatusChange: (listener: () => void) => {
      statusListeners.push(listener);
      return () => {};
    },
  };
  /** Live forwards keyed `${hostId}:${remotePort}`. */
  const remoteForwards = {
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
  };
  const portScanner = {
    start: vi.fn(),
    stop: vi.fn(),
    updateWorkspaces: vi.fn(),
    setEnricher: (fn: (ports: Port[]) => Port[]) => {
      enrich = fn;
    },
    refresh: () => {
      latest = enrich(results);
    },
    latest: () => latest,
    hasScanned: (hostId: string) => scannedHosts.has(hostId),
    onHostScanned: (listener: (hostId: string) => void) => {
      hostScanListeners.push(listener);
      return () => {};
    },
    scanNow: vi.fn().mockImplementation(scanAndPublish),
    /** An immediate scan of one host: every host's latest ports. */
    scanHost: vi.fn().mockImplementation(async (_hostId: string) => scanAndPublish()),
  };

  // Built once here rather than by `bridge/handlers/ports.ts` (ADR-183 moved that
  // construction to app-lifecycle.ts, alongside `paneHosts`).
  const remoteUrlResolver = new RemoteUrlResolver(
    portScanner as never,
    backendRegistry as never,
    remoteForwards as never,
  );

  return {
    backendRegistry,
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
    remoteUrlResolver,
    remoteForwards,
    portScanner,
    /** The scan result, mutable so a test can start a server "later". */
    scanned,
    backend: { ports: { kill: vi.fn() } },
    mainWindow: null,
    workspaceMeta,
  };
}

async function scan() {
  return (await portsScanNow(current)) as {
    port: number;
    hostname?: string;
  }[];
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("portless per-project gate", () => {
  beforeEach(() => {
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
    portsUpdateWorkspaceMetadata(current, [
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
    updateRoutes.mockClear();
  });

  const remoteScan = [
    { port: 3000, workspacePath: "/repo", hostId: "box" },
    { port: 4000, workspacePath: "/local" },
  ];

  it("routes a remote port only once it is forwarded, then to the forward", async () => {
    const deps = makeDeps(
      [meta({ hostId: "box" }), meta({ path: "/local", projectName: "loc" })],
      remoteScan,
    );
    register(deps as never);

    const ports = await scan();
    // The hostname is shown either way; the route waits for the forward.
    expect(ports.find((p) => p.port === 3000)!.hostname).toBe("acme.box.localhost:7999");
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "loc.localhost", port: 4000 },
    ]);

    // Opening the portless URL makes the forward, which re-routes.
    const url = await portsResolveUrl(current, "http://acme.box.localhost:7999/",
      "box",
    );
    expect(url).toBe("http://acme.box.localhost:7999/");
    expect(deps.remoteForwards.ensure).toHaveBeenCalledWith("box", 3000, {
      remoteHost: undefined,
    });
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "acme.box.localhost", port: 53000 },
      { hostname: "loc.localhost", port: 4000 },
    ]);
  });

  it("rewrites a reported remote port to its forward, and nothing else", async () => {
    const deps = makeDeps([], remoteScan);
    register(deps as never);
    await scan();
    const resolve = (url: string, hostId: string) =>
      portsResolveUrl(current, url, hostId);

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

  it("scans the host once more for a port its last scan did not report", async () => {
    const deps = makeDeps([], [...remoteScan]);
    register(deps as never);
    await scan();
    const resolve = (url: string) =>
      portsResolveUrl(current, url, "box");

    // A dev server started since the last poll: found by the rescan.
    deps.scanned.push({ port: 5173, workspacePath: "/srv/repo", hostId: "box" });
    expect(await resolve("http://localhost:5173/")).toBe("http://127.0.0.1:55173/");
    expect(deps.portScanner.scanHost).toHaveBeenCalledTimes(1);
    expect(deps.portScanner.scanHost).toHaveBeenCalledWith("box");

    // A known port needs no rescan; an unknown one gets exactly one.
    await resolve("http://localhost:3000/");
    expect(deps.portScanner.scanHost).toHaveBeenCalledTimes(1);
    expect(await resolve("http://localhost:4000/")).toBe("http://localhost:4000/");
    expect(deps.portScanner.scanHost).toHaveBeenCalledTimes(2);
  });

  it("hands the URL back unchanged when the forward cannot be made", async () => {
    const deps = makeDeps([], remoteScan);
    deps.remoteForwards.ensure.mockRejectedValueOnce(new Error("not connected"));
    register(deps as never);
    await scan();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      await portsResolveUrl(current, "http://localhost:3000/", "box"),
    ).toBe("http://localhost:3000/");
    warn.mockRestore();
  });

  it("forwards to [::1] for a port the scan saw only there", async () => {
    const deps = makeDeps([], [
      { port: 3000, workspacePath: "/repo", hostId: "box", loopbackHost: "::1" },
    ]);
    register(deps as never);
    await scan();
    await portsResolveUrl(current, "http://[::1]:3000/", "box");
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
      portsResolveUrl(current, "http://localhost:3000/", "box") as Promise<string>
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
      await portsResolveUrl(current, "https://example.com/", "box"),
    ).toBe("https://example.com/");
  });

  it("hands the URL back when the host is unregistered while waiting", async () => {
    const deps = makeDeps([], remoteScan);
    deps.host.setStatus("box", "connecting");
    register(deps as never);
    const pending = portsResolveUrl(current, "http://localhost:3000/",
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
      portsResolveUrl(current, url, "box") as Promise<string>;
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
    await portsResolveUrl(current, "http://localhost:3000/", "box");
    const remoteUrl = (url: string, hostId: string) =>
      portsRemoteUrl(current, url, hostId);
    expect(remoteUrl("http://127.0.0.1:53000/a?b#c", "box")).toBe("http://localhost:3000/a?b#c");
    expect(remoteUrl("http://127.0.0.1:53000/", "other")).toBe("http://127.0.0.1:53000/");
    expect(remoteUrl("http://127.0.0.1:53000/", "local")).toBe("http://127.0.0.1:53000/");
    expect(remoteUrl("http://localhost:8080/", "box")).toBe("http://localhost:8080/");
  });

  it("gives an agent's navigate the same rewrite, bounded by a timeout", async () => {
    // `resolvePaneUrl` (app-lifecycle.ts, ADR-183) calls this same
    // `remoteUrlResolver` with a timeout; exercised directly here since that
    // wiring no longer lives in `bridge/handlers/ports.ts`.
    const deps = makeDeps([], remoteScan);
    register(deps as never);
    await scan();
    expect(
      await deps.remoteUrlResolver.resolve("http://localhost:3000/", "box", 15_000),
    ).toBe("http://127.0.0.1:53000/");

    vi.useFakeTimers();
    try {
      deps.host.setStatus("box", "disconnected");
      const pending = deps.remoteUrlResolver.resolve("http://localhost:3000/", "box", 15_000);
      const assertion = expect(pending).rejects.toThrow(/not connected/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ADR-191 §6: a local and a remote checkout of one project can share a path
// and a name, so a remote hostname carries a segment from its host's id.
describe("hostnames by host", () => {
  beforeEach(() => {
    updateRoutes.mockClear();
  });

  const HOST = "3F1C2A9E-7b1d-4c2a-9e3f-000000000001";
  const OTHER = "3f1c2a9e-0000-4c2a-9e3f-000000000002";

  it("gives a local and a remote main at the same path distinct, working hostnames", async () => {
    const deps = makeDeps(
      [meta(), meta({ hostId: HOST })],
      [
        { port: 3000, workspacePath: "/repo" },
        { port: 3000, workspacePath: "/repo", hostId: HOST },
      ],
      new Map([[`${HOST}:3000`, 53000]]),
      [HOST],
    );
    register(deps as never);

    const ports = await scan();

    expect(ports.map((p) => p.hostname)).toEqual([
      "acme.localhost:7999",
      "acme.3f1c2a9e.localhost:7999",
    ]);
    // Each hostname routes to its own host's server.
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "acme.localhost", port: 3000 },
      { hostname: "acme.3f1c2a9e.localhost", port: 53000 },
    ]);
  });

  it("puts the host segment after the project for a remote branch", async () => {
    const deps = makeDeps(
      [meta({ hostId: HOST, branch: "feat-x", isMain: false })],
      [{ port: 3000, workspacePath: "/repo", hostId: HOST }],
      new Map(),
      [HOST],
    );
    register(deps as never);

    expect((await scan())[0].hostname).toBe("feat-x.acme.3f1c2a9e.localhost:7999");
  });

  it("leaves local hostnames unchanged when remote hosts are registered", async () => {
    const deps = makeDeps(
      [meta({ branch: "feat-x", isMain: false })],
      [{ port: 3000, workspacePath: "/repo" }],
      new Map(),
      [HOST, OTHER],
    );
    register(deps as never);

    expect((await scan())[0].hostname).toBe("feat-x.acme.localhost:7999");
  });

  it("uses each host's full id when two hosts share the prefix", async () => {
    const deps = makeDeps(
      [meta({ hostId: HOST }), meta({ hostId: OTHER })],
      [
        { port: 3000, workspacePath: "/repo", hostId: HOST },
        { port: 3000, workspacePath: "/repo", hostId: OTHER },
      ],
      new Map(),
      [HOST, OTHER],
    );
    register(deps as never);

    expect((await scan()).map((p) => p.hostname)).toEqual([
      "acme.3f1c2a9e-7b1d-4c2a-9e3f-000000000001.localhost:7999",
      "acme.3f1c2a9e-0000-4c2a-9e3f-000000000002.localhost:7999",
    ]);
  });

  it("matches metadata by host as well as path", async () => {
    // Only the remote project has portless on: the local port at the same
    // path must not borrow its metadata.
    const deps = makeDeps(
      [meta({ portlessEnabled: false }), meta({ hostId: HOST, projectName: "remote" })],
      [
        { port: 3000, workspacePath: "/repo" },
        { port: 4000, workspacePath: "/repo", hostId: HOST },
      ],
      new Map(),
      [HOST],
    );
    register(deps as never);

    const ports = await scan();

    expect(ports.find((p) => p.port === 3000)!.hostname).toBeUndefined();
    expect(ports.find((p) => p.port === 4000)!.hostname).toBe(
      "remote.3f1c2a9e.localhost:7999",
    );
  });

  it("gives a port from an unregistered host no hostname", async () => {
    const deps = makeDeps(
      [meta({ hostId: "gone" })],
      [{ port: 3000, workspacePath: "/repo", hostId: "gone" }],
      new Map(),
      [],
    );
    register(deps as never);

    expect((await scan())[0].hostname).toBeUndefined();
    expect(updateRoutes).toHaveBeenLastCalledWith([]);
  });
});
