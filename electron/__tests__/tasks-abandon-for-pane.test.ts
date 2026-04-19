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

describe("tasks:abandonForPane handler", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("marks the active task for a pane as abandoned", () => {
    deps.taskManager.getTaskByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
    });

    const handler = handlers.get("tasks:abandonForPane")!;
    handler({} as never, "pane-1");

    expect(deps.taskManager.updateTask).toHaveBeenCalledTimes(1);
    expect(deps.taskManager.updateTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "abandoned" }),
    );
    const [[, updates]] = (deps.taskManager.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).toHaveProperty("completedAt");
    expect(typeof updates.completedAt).toBe("string");
  });

  it("does nothing if no task for that pane", () => {
    deps.taskManager.getTaskByPaneId.mockReturnValue(undefined);

    const handler = handlers.get("tasks:abandonForPane")!;
    handler({} as never, "pane-99");

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("does nothing if task is not active", () => {
    deps.taskManager.getTaskByPaneId.mockReturnValue({
      id: "t1",
      status: "completed",
    });

    const handler = handlers.get("tasks:abandonForPane")!;
    handler({} as never, "pane-1");

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("sets task name from title when task has no name", () => {
    deps.taskManager.getTaskByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    const handler = handlers.get("tasks:abandonForPane")!;
    handler({} as never, "pane-1", "Fix conversation naming after slash clear command ⠻");

    expect(deps.taskManager.updateTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ name: "Fix conversation naming after slash clear command" }),
    );
  });

  it("preserves existing task name when title is also provided", () => {
    deps.taskManager.getTaskByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: "Existing task name",
    });

    const handler = handlers.get("tasks:abandonForPane")!;
    handler({} as never, "pane-1", "Some other title");

    const [[, updates]] = (deps.taskManager.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).not.toHaveProperty("name");
  });

  it("does not set name when title is a generic agent name", () => {
    deps.taskManager.getTaskByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    const handler = handlers.get("tasks:abandonForPane")!;
    handler({} as never, "pane-1", "claude ⠋");

    const [[, updates]] = (deps.taskManager.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).not.toHaveProperty("name");
  });
});
