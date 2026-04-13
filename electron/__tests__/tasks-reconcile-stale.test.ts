import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock electron ──────────────────────────────────────────────────────────────
const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

// ── Mock notifications ─────────────────────────────────────────────────────────
vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
}));

// ── Mock ipc-validate ──────────────────────────────────────────────────────────
vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import { register } from "../ipc/tasks";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<{
    id: string;
    status: string;
    agentSessionId: string | null;
  }> = {},
) {
  return {
    id: "t1",
    status: "active",
    agentSessionId: "s1",
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    taskManager: {
      getAllTasks: vi.fn().mockReturnValue([]),
      updateTask: vi.fn((id: string, updates: Record<string, unknown>) => ({
        id,
        ...updates,
      })),
      getTaskByPaneId: vi.fn().mockReturnValue(null),
      deleteTask: vi.fn(),
    },
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
      },
    },
    mainWindow: null,
    preferencesManager: {},
    paneContextMap: new Map(),
    unseenRespondedTasks: new Set(),
    unseenInputTasks: new Set(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("tasks:reconcileStale handler", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("marks active tasks with dead sessions as abandoned", async () => {
    deps.taskManager.getAllTasks.mockReturnValue([
      makeTask({ id: "t1", status: "active", agentSessionId: "s1" }), // dead
      makeTask({ id: "t2", status: "active", agentSessionId: "s2" }), // alive
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "s2" }]);

    const handler = handlers.get("tasks:reconcileStale")!;
    await handler({} as never);

    expect(deps.taskManager.updateTask).toHaveBeenCalledTimes(1);
    expect(deps.taskManager.updateTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "abandoned" }),
    );
    const [[, updates]] = (deps.taskManager.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).toHaveProperty("completedAt");
    expect(typeof updates.completedAt).toBe("string");
  });

  it("does nothing when daemon is unreachable", async () => {
    deps.backend.pty.listSessions.mockRejectedValue(new Error("ECONNREFUSED"));

    const handler = handlers.get("tasks:reconcileStale")!;
    await handler({} as never);

    expect(deps.taskManager.getAllTasks).not.toHaveBeenCalled();
    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("skips tasks with null agentSessionId", async () => {
    deps.taskManager.getAllTasks.mockReturnValue([
      makeTask({ id: "t1", status: "active", agentSessionId: null }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    const handler = handlers.get("tasks:reconcileStale")!;
    await handler({} as never);

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("skips non-active tasks", async () => {
    deps.taskManager.getAllTasks.mockReturnValue([
      makeTask({ id: "t1", status: "completed", agentSessionId: "s1" }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    const handler = handlers.get("tasks:reconcileStale")!;
    await handler({} as never);

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });
});
