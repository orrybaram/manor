import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TaskInfo } from "../../electron.d";

// ── Mock electronAPI ──────────────────────────────────────────────────────────
// Mirrors the pattern in task-store-pagination.test.ts: replace `electronAPI.tasks`
// before importing the store, so its eager init picks up the stub.

let onUpdateCallback:
  | ((task: TaskInfo, unseen: { responded: boolean; requires_input: boolean }) => void)
  | null = null;

const tasksApi = {
  getAll: vi.fn().mockResolvedValue([]),
  getActive: vi.fn().mockResolvedValue([]),
  getRecent: vi.fn().mockResolvedValue([]),
  getUnseen: vi.fn().mockResolvedValue({ responded: [], requires_input: [] }),
  consumePruneNotice: vi.fn().mockResolvedValue(0),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  setPaneContext: vi.fn(),
  markSeen: vi.fn(),
  markResumed: vi.fn(),
  reconcileStale: vi.fn(),
  abandonForPane: vi.fn(),
  onUpdate: vi.fn(
    (
      cb: (
        task: TaskInfo,
        unseen: { responded: boolean; requires_input: boolean },
      ) => void,
    ) => {
      onUpdateCallback = cb;
      return () => {};
    },
  ),
};

const notificationsApi = {
  getAll: vi.fn().mockResolvedValue([]),
  onChanged: vi.fn(() => () => {}),
  onNavigate: vi.fn(() => () => {}),
};

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  tasks: tasksApi,
  notifications: notificationsApi,
};

function makeTask(
  id: string,
  lastAgentStatus: string | null = null,
  paneId: string | null = null,
): TaskInfo {
  return {
    id,
    agentSessionId: `agent-${id}`,
    name: `Task ${id}`,
    status: "active",
    createdAt: "2024-01-15T00:00:00Z",
    updatedAt: "2024-01-15T00:00:00Z",
    completedAt: null,
    activatedAt: null,
    projectId: null,
    projectName: null,
    workspacePath: null,
    cwd: "/",
    agentKind: "claude",
    agentCommand: null,
    paneId,
    lastAgentStatus,
    resumedAt: null,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("task-store unseen-flag cache (ADR-136)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Re-prime defaults that vi.clearAllMocks erased.
    tasksApi.getAll.mockResolvedValue([]);
    tasksApi.getActive.mockResolvedValue([]);
    tasksApi.getRecent.mockResolvedValue([]);
    tasksApi.getUnseen.mockResolvedValue({ responded: [], requires_input: [] });
    tasksApi.consumePruneNotice.mockResolvedValue(0);
    onUpdateCallback = null;
  });

  it("primes unseen Sets from tasks:getUnseen on init", async () => {
    tasksApi.getUnseen.mockResolvedValue({
      responded: ["t1", "t2"],
      requires_input: ["t3"],
    });

    const { useTaskStore } = await import("../task-store");
    await flush();

    const state = useTaskStore.getState();
    expect(state.unseenRespondedTaskIds).toEqual(new Set(["t1", "t2"]));
    expect(state.unseenInputTaskIds).toEqual(new Set(["t3"]));
  });

  it("reconciles unseen Sets to broadcast flags on every task-updated event", async () => {
    const { useTaskStore } = await import("../task-store");
    await flush();
    expect(onUpdateCallback).not.toBeNull();

    // Status flip storm: responded -> requires_input -> responded.
    onUpdateCallback!(makeTask("t1", "responded"), {
      responded: true,
      requires_input: false,
    });
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(true);
    expect(useTaskStore.getState().unseenInputTaskIds.has("t1")).toBe(false);

    onUpdateCallback!(makeTask("t1", "requires_input"), {
      responded: false,
      requires_input: true,
    });
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(false);
    expect(useTaskStore.getState().unseenInputTaskIds.has("t1")).toBe(true);

    onUpdateCallback!(makeTask("t1", "responded"), {
      responded: true,
      requires_input: false,
    });
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(true);
    expect(useTaskStore.getState().unseenInputTaskIds.has("t1")).toBe(false);
  });

  it("markTaskSeen optimistically clears local cache and calls IPC", async () => {
    tasksApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: ["t1"],
    });

    const { useTaskStore } = await import("../task-store");
    await flush();

    useTaskStore.getState().markTaskSeen("t1");

    const state = useTaskStore.getState();
    expect(state.unseenRespondedTaskIds.has("t1")).toBe(false);
    expect(state.unseenInputTaskIds.has("t1")).toBe(false);
    expect(tasksApi.markSeen).toHaveBeenCalledWith("t1");
  });

  it("re-pulses on a subsequent status update after markTaskSeen", async () => {
    tasksApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: [],
    });

    const { useTaskStore } = await import("../task-store");
    await flush();

    // Mark seen — cache clears.
    useTaskStore.getState().markTaskSeen("t1");
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(false);

    // A later broadcast (e.g. another responded after a new turn) puts the
    // task back into the unseen Set, so the pulse predicate fires again.
    onUpdateCallback!(makeTask("t1", "responded"), {
      responded: true,
      requires_input: false,
    });
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(true);
  });

  it("leaves the cache untouched when the broadcast omits the unseen argument", async () => {
    tasksApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: [],
    });

    const { useTaskStore } = await import("../task-store");
    await flush();

    // Older preload — no unseen arg. Cache should not be wiped.
    onUpdateCallback!(makeTask("t1", "responded"), undefined as never);
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(true);
  });
});

/**
 * A one-panel, one-tab layout showing `visiblePaneId`, with `hiddenPaneId` (if
 * given) parked in a second, unselected tab.
 */
function layoutWith(
  visiblePaneId: string,
  hiddenPaneId?: string,
): Record<string, unknown> {
  const tabs = [
    {
      id: "tab-visible",
      title: "visible",
      rootNode: { type: "leaf", paneId: visiblePaneId },
      focusedPaneId: visiblePaneId,
    },
  ];
  if (hiddenPaneId) {
    tabs.push({
      id: "tab-hidden",
      title: "hidden",
      rootNode: { type: "leaf", paneId: hiddenPaneId },
      focusedPaneId: hiddenPaneId,
    });
  }
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs,
        selectedTabId: "tab-visible",
        pinnedTabIds: [],
      },
    },
    activePanelId: "panel-1",
  };
}

describe("read state follows what is on screen (issue #142)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tasksApi.getAll.mockResolvedValue([]);
    tasksApi.getActive.mockResolvedValue([]);
    tasksApi.getRecent.mockResolvedValue([]);
    tasksApi.getUnseen.mockResolvedValue({ responded: [], requires_input: [] });
    tasksApi.consumePruneNotice.mockResolvedValue(0);
    onUpdateCallback = null;
  });

  it("marks a task seen when navigation brings its pane on screen", async () => {
    const { useTaskStore } = await import("../task-store");
    const { useAppStore } = await import("../app-store");
    await flush();

    // Agent responds while the user is elsewhere — no active workspace at all.
    onUpdateCallback!(makeTask("t1", "responded", "pane-1"), {
      responded: true,
      requires_input: false,
    });
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(true);
    expect(tasksApi.markSeen).not.toHaveBeenCalled();

    // The user navigates to the pane by any means: the layout mutation is the
    // only signal the store needs.
    useAppStore.setState({
      activeWorkspacePath: "/ws",
      workspaceLayouts: { "/ws": layoutWith("pane-1") } as never,
    });

    expect(tasksApi.markSeen).toHaveBeenCalledWith("t1");
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(false);
  });

  it("leaves a task unseen while its pane sits in a background tab", async () => {
    const { useTaskStore } = await import("../task-store");
    const { useAppStore } = await import("../app-store");
    await flush();

    onUpdateCallback!(makeTask("t1", "requires_input", "pane-hidden"), {
      responded: false,
      requires_input: true,
    });

    useAppStore.setState({
      activeWorkspacePath: "/ws",
      workspaceLayouts: {
        "/ws": layoutWith("pane-visible", "pane-hidden"),
      } as never,
    });

    // The tab is mounted but not selected, so nothing has been read.
    expect(tasksApi.markSeen).not.toHaveBeenCalled();
    expect(useTaskStore.getState().unseenInputTaskIds.has("t1")).toBe(true);
  });

  it("clears unseen flags that arrive for a pane already on screen", async () => {
    // Boot order matters here: the layout is restored before the unseen
    // snapshot lands, which is the ordinary case after a relaunch.
    const { useAppStore } = await import("../app-store");
    useAppStore.setState({
      activeWorkspacePath: "/ws",
      workspaceLayouts: { "/ws": layoutWith("pane-1") } as never,
    });

    tasksApi.getActive.mockResolvedValue([
      makeTask("t1", "responded", "pane-1"),
    ]);
    tasksApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: [],
    });

    const { useTaskStore } = await import("../task-store");
    await flush();

    expect(tasksApi.markSeen).toHaveBeenCalledWith("t1");
    expect(useTaskStore.getState().unseenRespondedTaskIds.has("t1")).toBe(false);
  });
});
