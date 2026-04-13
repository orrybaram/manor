import { describe, it, expect, beforeEach, vi } from "vitest";
import { navigateToTask } from "../task-navigation";
import { useProjectStore } from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import { useToastStore } from "../../store/toast-store";
import { useTaskStore } from "../../store/task-store";
import type { TaskInfo } from "../../electron.d";
import type { ProjectInfo, WorkspaceLayout } from "../../store/project-store";

// ---------------------------------------------------------------------------
// Window mock — must include all APIs accessed at module-init time by the
// stores imported transitively (task-store, app-store, project-store).
// ---------------------------------------------------------------------------

const markSeenMock = vi.fn();

vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
    layout: {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    },
    tasks: {
      onUpdate: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      markSeen: markSeenMock,
    },
    notifications: {
      onNavigateToTask: vi.fn(),
    },
  },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-1";
const WS_PATH = "/test/workspace";
const PANE_ID = "pane-1";
const TASK_ID = "task-1";

function makeProject(): ProjectInfo {
  return {
    id: PROJECT_ID,
    name: "Test Project",
    path: "/test",
    defaultBranch: "main",
    workspaces: [{ path: WS_PATH, branch: "main", isMain: true, name: null }],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: null,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
  };
}

function makeLayout(): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [
          {
            id: "tab-1",
            title: "Terminal",
            rootNode: { type: "leaf", paneId: PANE_ID },
            focusedPaneId: PANE_ID,
          },
        ],
        selectedTabId: "tab-1",
        pinnedTabIds: [],
      },
    },
    activePanelId: "panel-1",
  };
}

function makeTask(overrides?: Partial<TaskInfo>): TaskInfo {
  return {
    id: TASK_ID,
    agentSessionId: "session-1",
    name: "Test task",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    activatedAt: null,
    projectId: PROJECT_ID,
    projectName: "Test Project",
    workspacePath: WS_PATH,
    cwd: WS_PATH,
    agentKind: "claude",
    agentCommand: null,
    paneId: PANE_ID,
    lastAgentStatus: "requires_input",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("navigateToTask toast cleanup", () => {
  beforeEach(() => {
    markSeenMock.mockClear();
    useProjectStore.setState({ projects: [makeProject()], selectedProjectIndex: 0 });
    useAppStore.setState({
      activeWorkspacePath: WS_PATH,
      workspaceLayouts: { [WS_PATH]: makeLayout() },
    });
    useToastStore.setState({ toasts: [] });
    useTaskStore.setState({ tasks: [], seenTaskIds: new Set() });
  });

  it("removes the task-input toast when navigating to the task", () => {
    const toastId = `task-input-${TASK_ID}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Task needs input",
      status: "loading",
      persistent: true,
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    navigateToTask(makeTask());

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("is a no-op when no toast exists for the task", () => {
    expect(useToastStore.getState().toasts).toHaveLength(0);

    navigateToTask(makeTask());

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does not remove toasts belonging to other tasks", () => {
    const otherToastId = `task-input-other-task`;
    useToastStore.getState().addToast({
      id: otherToastId,
      message: "Task needs input",
      status: "loading",
      persistent: true,
    });

    navigateToTask(makeTask());

    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].id).toBe(otherToastId);
  });

  it("does not remove toast when project is not found (early return)", () => {
    useProjectStore.setState({ projects: [] });
    const toastId = `task-input-${TASK_ID}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Task needs input",
      status: "loading",
      persistent: true,
    });

    navigateToTask(makeTask());

    // navigateToTask returns early without reaching removeToast
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("does not remove toast when workspace is not found (early return)", () => {
    const toastId = `task-input-${TASK_ID}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Task needs input",
      status: "loading",
      persistent: true,
    });

    navigateToTask(makeTask({ workspacePath: "/nonexistent/path" }));

    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
