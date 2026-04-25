/**
 * ADR-136 §"Change 3" — main is the source of truth for unseen flags.
 *
 * Verifies:
 *   - `tasks:getUnseen` returns the snapshot helper's output verbatim
 *     (renderer uses this to prime its cache on boot).
 *   - `tasks:markSeen` mutates the unseen Sets AND re-broadcasts the task,
 *     so the renderer cache stays in sync.
 */

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
// vi.mock is hoisted; we declare the mocked module inline and grab the fns
// via the imported module reference below.
vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  sendTaskUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({
    responded: ["t1", "t2"],
    requires_input: ["t3"],
  })),
}));

vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import * as notifications from "../notifications";
import { register } from "../ipc/tasks";

const sendTaskUpdate = vi.mocked(notifications.sendTaskUpdate);
const updateDockBadge = vi.mocked(notifications.updateDockBadge);
const getUnseenSnapshot = vi.mocked(notifications.getUnseenSnapshot);

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
      pty: { listSessions: vi.fn().mockResolvedValue([]) },
    },
    mainWindow: null,
    preferencesManager: { get: vi.fn().mockReturnValue(false), set: vi.fn() },
    paneContextMap: new Map(),
    unseenRespondedTasks: new Set<string>(),
    unseenInputTasks: new Set<string>(),
    ...overrides,
  };
}

describe("tasks:getUnseen (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    sendTaskUpdate.mockClear();
    updateDockBadge.mockClear();
    deps = makeDeps();
    register(deps as never);
  });

  it("returns the snapshot helper's output verbatim", async () => {
    const handler = handlers.get("tasks:getUnseen")!;
    expect(handler).toBeDefined();
    const result = await handler({} as never);
    expect(result).toEqual({
      responded: ["t1", "t2"],
      requires_input: ["t3"],
    });
    expect(getUnseenSnapshot).toHaveBeenCalled();
  });
});

describe("tasks:markSeen re-broadcast (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    sendTaskUpdate.mockClear();
    updateDockBadge.mockClear();
    deps = makeDeps({
      unseenRespondedTasks: new Set<string>(["t1"]),
      unseenInputTasks: new Set<string>(["t1"]),
    });
    register(deps as never);
  });

  it("clears both Sets and re-broadcasts the task with fresh flags", async () => {
    const task = { id: "t1", lastAgentStatus: "responded" };
    deps.taskManager.getAllTasks.mockReturnValue([task]);

    const handler = handlers.get("tasks:markSeen")!;
    await handler({} as never, "t1");

    expect(deps.unseenRespondedTasks.has("t1")).toBe(false);
    expect(deps.unseenInputTasks.has("t1")).toBe(false);
    expect(sendTaskUpdate).toHaveBeenCalledTimes(1);
    expect(sendTaskUpdate).toHaveBeenCalledWith(
      deps.mainWindow,
      task,
      deps.preferencesManager,
    );
  });

  it("falls back to dock-badge refresh when the task no longer exists", async () => {
    deps.taskManager.getAllTasks.mockReturnValue([]);

    const handler = handlers.get("tasks:markSeen")!;
    await handler({} as never, "t1");

    expect(deps.unseenRespondedTasks.has("t1")).toBe(false);
    expect(sendTaskUpdate).not.toHaveBeenCalled();
    expect(updateDockBadge).toHaveBeenCalled();
  });
});
