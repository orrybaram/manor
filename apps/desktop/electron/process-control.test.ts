import { describe, it, expect, vi } from "vitest";

// ── Mock LayoutPersistence, the way processes-kill-stats.test.ts mocks
// ../portless: replace the module with a stub so `listProcesses` doesn't
// touch the real (isolated-home) layout file. ──
const getActiveSessionIds = vi.fn(() => new Set<string>(["s1"]));

vi.mock("./terminal-host/layout-persistence", () => ({
  LayoutPersistence: class {
    getActiveSessionIds = getActiveSessionIds;
  },
}));

vi.mock("./portless", () => ({
  portlessManager: { proxyPort: null, restart: vi.fn() },
}));

import { listProcesses } from "./process-control";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
      },
    },
    agentHookServer: { hookPort: 1234 },
    webviewServer: { serverPort: 5678 },
    portScanner: {
      scanNow: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  } as never;
}

describe("listProcesses", () => {
  it("marks a session not referenced by the active layout as orphaned", async () => {
    // Daemon isn't alive (no pid file in the isolated test $HOME), so
    // `alive` is false and `sessions` would normally stay empty — force the
    // alive branch by stubbing `readDaemonPid`/`isDaemonAlive` indirectly:
    // instead, exercise the mapping logic directly by making the daemon
    // "alive" via a real pid file for the current process.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { daemonPidFile } = await import("./paths");
    fs.mkdirSync(path.dirname(daemonPidFile()), { recursive: true });
    fs.writeFileSync(daemonPidFile(), String(process.pid));

    const deps = makeDeps({
      backend: {
        pty: {
          listSessions: vi.fn().mockResolvedValue([
            { sessionId: "s1", alive: true, cwd: "/repo/a" },
            { sessionId: "s2", alive: true, cwd: "/repo/b" },
          ]),
        },
      },
    });

    const result = await listProcesses(deps);

    expect(result.daemon.alive).toBe(true);
    expect(result.sessions).toEqual([
      { sessionId: "s1", alive: true, cwd: "/repo/a", orphaned: false },
      { sessionId: "s2", alive: true, cwd: "/repo/b", orphaned: true },
    ]);

    fs.rmSync(daemonPidFile(), { force: true });
  });

  it("returns an empty session list when the daemon is not alive", async () => {
    const deps = makeDeps();
    const result = await listProcesses(deps);

    expect(result.daemon.alive).toBe(false);
    expect(result.sessions).toEqual([]);
  });
});
