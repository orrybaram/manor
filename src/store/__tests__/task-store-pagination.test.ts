import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TaskInfo } from "../../electron.d";

// ── Mock electronAPI ──────────────────────────────────────────────────────────
// The vitest setup file (src/store/__tests__/setup.ts) defines a minimal
// `window.electronAPI`. We replace `tasks` with a fully-stubbed object before
// the task-store module is imported, so its eager init picks up the stub.

const tasksApi = {
  getAll: vi.fn(),
  getActive: vi.fn(),
  getRecent: vi.fn(),
  consumePruneNotice: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  setPaneContext: vi.fn(),
  markSeen: vi.fn(),
  markResumed: vi.fn(),
  reconcileStale: vi.fn(),
  abandonForPane: vi.fn(),
  onUpdate: vi.fn(),
};

const notificationsApi = {
  onNavigateToTask: vi.fn(),
};

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  tasks: tasksApi,
  notifications: notificationsApi,
};

function makeTask(id: string, createdAt: string, status: TaskInfo["status"] = "active"): TaskInfo {
  return {
    id,
    agentSessionId: `agent-${id}`,
    name: `Task ${id}`,
    status,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    activatedAt: null,
    projectId: null,
    projectName: null,
    workspacePath: null,
    cwd: "/",
    agentKind: "claude",
    agentCommand: null,
    paneId: null,
    lastAgentStatus: null,
    resumedAt: null,
  };
}

function makePage(prefix: string, count: number): TaskInfo[] {
  return Array.from({ length: count }, (_, i) => {
    // Newer indices first (descending createdAt)
    const ts = new Date(2024, 0, 100 - i, 0, 0, 0).toISOString();
    return makeTask(`${prefix}-${i}`, ts);
  });
}

describe("task-store pagination (ADR-136)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tasksApi.consumePruneNotice.mockResolvedValue(0);
  });

  it("merges tasks:getActive and tasks:getAll, dedupes overlap, sorts desc", async () => {
    const active = [makeTask("a1", "2024-01-15T00:00:00Z", "active")];
    const recentPage = [
      makeTask("a1", "2024-01-15T00:00:00Z", "active"), // overlap with active
      makeTask("c1", "2024-01-10T00:00:00Z", "completed"),
      makeTask("c2", "2024-01-05T00:00:00Z", "completed"),
    ];
    tasksApi.getActive.mockResolvedValue(active);
    tasksApi.getAll.mockResolvedValue(recentPage);

    const { useTaskStore } = await import("../task-store");

    // Wait one tick for the async init to resolve.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const state = useTaskStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.tasks.map((t) => t.id)).toEqual(["a1", "c1", "c2"]);
    expect(tasksApi.getActive).toHaveBeenCalledTimes(1);
    expect(tasksApi.getAll).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  it("sets hasMore=true when initial getAll returns a full page", async () => {
    tasksApi.getActive.mockResolvedValue([]);
    tasksApi.getAll.mockResolvedValue(makePage("p", 100));

    const { useTaskStore } = await import("../task-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useTaskStore.getState().hasMore).toBe(true);
  });

  it("sets hasMore=false when initial getAll returns a partial page", async () => {
    tasksApi.getActive.mockResolvedValue([]);
    tasksApi.getAll.mockResolvedValue(makePage("p", 7));

    const { useTaskStore } = await import("../task-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useTaskStore.getState().hasMore).toBe(false);
  });

  it("loadMoreTasks coalesces concurrent calls and only fires once", async () => {
    tasksApi.getActive.mockResolvedValue([]);
    tasksApi.getAll.mockResolvedValueOnce(makePage("p", 100));

    const { useTaskStore } = await import("../task-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useTaskStore.getState().hasMore).toBe(true);

    // Second batch (the load-more page).
    tasksApi.getAll.mockResolvedValueOnce(makePage("q", 5));

    const store = useTaskStore.getState();
    // Fire three overlapping calls — only one should reach the API.
    const calls = [
      store.loadMoreTasks(100),
      store.loadMoreTasks(100),
      store.loadMoreTasks(100),
    ];
    await Promise.all(calls);

    // Initial getAll + one load-more call = 2 total
    expect(tasksApi.getAll).toHaveBeenCalledTimes(2);
    expect(tasksApi.getAll).toHaveBeenLastCalledWith({ offset: 100, limit: 100 });
    expect(useTaskStore.getState().hasMore).toBe(false);
  });

  it("loadMoreTasks short-circuits when hasMore is false", async () => {
    tasksApi.getActive.mockResolvedValue([]);
    tasksApi.getAll.mockResolvedValue(makePage("p", 7)); // partial page → hasMore=false

    const { useTaskStore } = await import("../task-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useTaskStore.getState().hasMore).toBe(false);
    const callsBefore = tasksApi.getAll.mock.calls.length;

    await useTaskStore.getState().loadMoreTasks(7);
    expect(tasksApi.getAll.mock.calls.length).toBe(callsBefore);
  });
});
