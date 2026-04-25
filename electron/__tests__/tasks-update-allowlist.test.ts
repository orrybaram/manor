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
  sendTaskUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
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

describe("tasks:update allowlist", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("accepts { name: 'x' } and forwards to taskManager.updateTask", async () => {
    const handler = handlers.get("tasks:update")!;
    const result = await handler({} as never, "task-1", { name: "x" });

    expect(deps.taskManager.updateTask).toHaveBeenCalledWith("task-1", { name: "x" });
    expect(result).toMatchObject({ id: "task-1", name: "x" });
  });

  it("accepts { name: null } and forwards to taskManager.updateTask", async () => {
    const handler = handlers.get("tasks:update")!;
    await handler({} as never, "task-1", { name: null });

    expect(deps.taskManager.updateTask).toHaveBeenCalledWith("task-1", { name: null });
  });

  it("throws when updates contains status field", () => {
    const handler = handlers.get("tasks:update")!;

    expect(() => handler({} as never, "task-1", { status: "abandoned" })).toThrow(
      'tasks:update: field "status" is not writable from renderer',
    );

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("throws when updates contains both name and a forbidden field", () => {
    const handler = handlers.get("tasks:update")!;

    expect(() => handler({} as never, "task-1", { name: "x", status: "active" })).toThrow(
      'tasks:update: field "status" is not writable from renderer',
    );

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("throws when updates is not an object (string)", () => {
    const handler = handlers.get("tasks:update")!;

    expect(() => handler({} as never, "task-1", "not-an-object")).toThrow(
      "tasks:update: updates must be an object",
    );

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("throws when updates is null", () => {
    const handler = handlers.get("tasks:update")!;

    expect(() => handler({} as never, "task-1", null)).toThrow(
      "tasks:update: updates must be an object",
    );

    expect(deps.taskManager.updateTask).not.toHaveBeenCalled();
  });

  it("throws when updates contains agentSessionId", () => {
    const handler = handlers.get("tasks:update")!;

    expect(() => handler({} as never, "task-1", { agentSessionId: "some-id" })).toThrow(
      'tasks:update: field "agentSessionId" is not writable from renderer',
    );
  });

  it("throws when updates contains paneId", () => {
    const handler = handlers.get("tasks:update")!;

    expect(() => handler({} as never, "task-1", { paneId: "pane-1" })).toThrow(
      'tasks:update: field "paneId" is not writable from renderer',
    );
  });
});
