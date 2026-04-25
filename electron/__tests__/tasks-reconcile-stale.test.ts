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
    paneId: string | null;
  }> = {},
) {
  return {
    id: "t1",
    status: "active",
    agentSessionId: "agent-uuid-default",
    paneId: "pane-default",
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
      makeTask({ id: "t1", status: "active", paneId: "pane-1" }), // dead
      makeTask({ id: "t2", status: "active", paneId: "pane-2" }), // alive
    ]);
    // listSessions() returns pane IDs — only pane-2 is live
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "pane-2" }]);

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

  it("skips tasks with null paneId", async () => {
    deps.taskManager.getAllTasks.mockReturnValue([
      makeTask({ id: "t1", status: "active", paneId: null }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    const handler = handlers.get("tasks:reconcileStale")!;
    await handler({} as never);

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("skips non-active tasks", async () => {
    deps.taskManager.getAllTasks.mockReturnValue([
      makeTask({ id: "t1", status: "completed", paneId: "pane-1" }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    const handler = handlers.get("tasks:reconcileStale")!;
    await handler({} as never);

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("regression: does not abandon a task when paneId is live but agentSessionId is not", async () => {
    // This is the original namespace bug: the old code compared agentSessionId
    // against listSessions().sessionId, which actually returns pane IDs.
    // A task with paneId "pane-1" should be considered live when listSessions()
    // returns [{ sessionId: "pane-1" }], even if agentSessionId is a different UUID.
    deps.taskManager.getAllTasks.mockReturnValue([
      makeTask({
        id: "t1",
        status: "active",
        agentSessionId: "agent-uuid-1", // different namespace — NOT in listSessions results
        paneId: "pane-1",              // correct namespace — IS in listSessions results
      }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "pane-1" }]);

    const handler = handlers.get("tasks:reconcileStale")!;
    await handler({} as never);

    // paneId "pane-1" is live → task must NOT be abandoned
    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });
});
