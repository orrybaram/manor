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
  scanned: { port: number; workspacePath: string }[] = [
    { port: 3000, workspacePath: "/repo" },
  ],
) {
  return {
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
