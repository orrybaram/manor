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
  scanned: { port: number; workspacePath: string; hostId?: string }[] = [
    { port: 3000, workspacePath: "/repo" },
  ],
  forwarded: Map<string, number> = new Map(),
) {
  const changeListeners: (() => void)[] = [];
  return {
    backendRegistry: { provider: () => undefined },
    /** Live forwards keyed `${hostId}:${remotePort}`. */
    remoteForwards: {
      localPort: (hostId: string, port: number) => forwarded.get(`${hostId}:${port}`),
      ensure: vi.fn(async (hostId: string, port: number) => {
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
    expect(deps.remoteForwards.ensure).toHaveBeenCalledWith("box", 3000);
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

    expect(await resolve("http://localhost:3000/app?x=1", "box")).toBe(
      "http://localhost:53000/app?x=1",
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
});
