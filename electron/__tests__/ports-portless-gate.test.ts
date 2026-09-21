/**
 * The portless per-project gate, exercised through `ports.scanNow` and
 * `ports.updateWorkspaceMetadata`.
 *
 * No `ipcMain` here any more: `ports` crossed to the handler table in
 * ADR-180 ticket 8, so these are plain functions over `HostDeps` — the same
 * functions the table calls, and a paired `full` device now reaches them the
 * same way the desktop does.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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

import { portsScanNow, portsUpdateWorkspaceMetadata } from "../bridge/handlers/ports";
import { localCtx } from "../bridge/method";
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

async function scan(deps: ReturnType<typeof makeDeps>) {
  return (await portsScanNow(localCtx(deps as never))) as {
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
    const deps = makeDeps([meta()]);

    const ports = await scan(deps);

    expect(ports[0].hostname).toBe("acme.localhost:7999");
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "acme.localhost", port: 3000 },
    ]);
  });

  it("leaves the port on plain localhost and registers no route when disabled", async () => {
    const deps = makeDeps([meta({ portlessEnabled: false })]);

    const ports = await scan(deps);

    expect(ports[0].hostname).toBeUndefined();
    expect(updateRoutes).toHaveBeenLastCalledWith([]);
  });

  /** A workspace from a project persisted before the flag existed. */
  it("treats a missing portlessEnabled as enabled", async () => {
    const legacy = meta();
    delete (legacy as Partial<WorkspaceMeta>).portlessEnabled;
    const deps = makeDeps([legacy]);

    const ports = await scan(deps);

    expect(ports[0].hostname).toBe("acme.localhost:7999");
  });

  it("drops the hostname and the route once the toggle is flipped off", async () => {
    const deps = makeDeps([meta()]);
    expect((await scan(deps))[0].hostname).toBe("acme.localhost:7999");

    // What the renderer pushes when the settings switch changes.
    portsUpdateWorkspaceMetadata(localCtx(deps as never), [meta({ portlessEnabled: false })]);

    const ports = await scan(deps);
    expect(ports[0].hostname).toBeUndefined();
    expect(updateRoutes).toHaveBeenLastCalledWith([]);
  });

  it("gates per project — a disabled project does not affect an enabled one", async () => {
    const deps = makeDeps(
      [
        meta(),
        meta({ path: "/other", projectName: "other", portlessEnabled: false }),
      ],
      [
        { port: 3000, workspacePath: "/repo" },
        { port: 4000, workspacePath: "/other" },
      ],
    );

    const ports = await scan(deps);

    expect(ports.find((p) => p.port === 3000)!.hostname).toBe(
      "acme.localhost:7999",
    );
    expect(ports.find((p) => p.port === 4000)!.hostname).toBeUndefined();
    expect(updateRoutes).toHaveBeenLastCalledWith([
      { hostname: "acme.localhost", port: 3000 },
    ]);
  });
});
