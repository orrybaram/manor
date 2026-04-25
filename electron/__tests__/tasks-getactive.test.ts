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

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    taskManager: {
      getAllTasks: vi.fn().mockReturnValue([]),
      getActiveTasks: vi.fn().mockReturnValue([]),
      getLastPruneCount: vi.fn().mockReturnValue(0),
      updateTask: vi.fn(),
      getTaskByPaneId: vi.fn().mockReturnValue(null),
      deleteTask: vi.fn(),
    },
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
      },
    },
    mainWindow: null,
    preferencesManager: {
      get: vi.fn().mockReturnValue(false),
      set: vi.fn(),
    },
    paneContextMap: new Map(),
    unseenRespondedTasks: new Set(),
    unseenInputTasks: new Set(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("tasks:getActive (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("returns getActiveTasks() output verbatim", async () => {
    const active = [
      { id: "t1", status: "active" },
      { id: "t2", status: "active" },
    ];
    deps.taskManager.getActiveTasks.mockReturnValue(active);

    const handler = handlers.get("tasks:getActive")!;
    expect(handler).toBeDefined();

    const result = await handler({} as never);
    expect(result).toBe(active);
    expect(deps.taskManager.getActiveTasks).toHaveBeenCalledTimes(1);
  });

  it("never invokes the sort/slice path of getAllTasks", async () => {
    const handler = handlers.get("tasks:getActive")!;
    await handler({} as never);

    expect(deps.taskManager.getAllTasks).not.toHaveBeenCalled();
  });

  it("does not require any arguments", () => {
    const handler = handlers.get("tasks:getActive")!;
    // Calling with only the implicit IpcMainInvokeEvent argument.
    const result = handler({} as never);
    expect(result).toBeDefined();
  });
});

describe("tasks:getRecent (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("calls getAllTasks with the requested limit", async () => {
    const handler = handlers.get("tasks:getRecent")!;
    expect(handler).toBeDefined();

    await handler({} as never, { limit: 25 });
    expect(deps.taskManager.getAllTasks).toHaveBeenCalledWith({ limit: 25 });
  });

  it("defaults to a limit of 50 when none is provided", async () => {
    const handler = handlers.get("tasks:getRecent")!;
    await handler({} as never);
    expect(deps.taskManager.getAllTasks).toHaveBeenCalledWith({ limit: 50 });
  });
});

describe("tasks:consumePruneNotice (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("returns 0 when nothing was pruned", async () => {
    deps.taskManager.getLastPruneCount.mockReturnValue(0);

    const handler = handlers.get("tasks:consumePruneNotice")!;
    const result = await handler({} as never);
    expect(result).toBe(0);
    expect(deps.preferencesManager.set).not.toHaveBeenCalled();
  });

  it("returns the count and sets the shown flag on first call", async () => {
    deps.taskManager.getLastPruneCount.mockReturnValue(5);
    deps.preferencesManager.get.mockReturnValue(false);

    const handler = handlers.get("tasks:consumePruneNotice")!;
    const result = await handler({} as never);
    expect(result).toBe(5);
    expect(deps.preferencesManager.set).toHaveBeenCalledWith(
      "taskPruneNoticeShown",
      true,
    );
  });

  it("returns 0 when the shown flag is already set, even if count > 0", async () => {
    deps.taskManager.getLastPruneCount.mockReturnValue(5);
    deps.preferencesManager.get.mockReturnValue(true);

    const handler = handlers.get("tasks:consumePruneNotice")!;
    const result = await handler({} as never);
    expect(result).toBe(0);
    expect(deps.preferencesManager.set).not.toHaveBeenCalled();
  });
});
