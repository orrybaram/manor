import { describe, it, expect, beforeEach, vi } from "vitest";
import { navigateToAgent } from "../agent-navigation";
import { useProjectStore } from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import { useToastStore } from "../../store/toast-store";
import { useAgentStore } from "../../store/agent-store";
import type { AgentInfo } from "../../electron.d";
import type { ProjectInfo, WorkspaceLayout } from "../../store/project-store";

// ---------------------------------------------------------------------------
// Window mock — must include all APIs accessed at module-init time by the
// stores imported transitively (agent-store, app-store, project-store).
// ---------------------------------------------------------------------------

const markSeenMock = vi.fn();

vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
    layout: {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
    },
    agents: {
      onUpdate: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      markSeen: markSeenMock,
    },
    notifications: {
      getAll: vi.fn().mockResolvedValue([]),
  onChanged: vi.fn(() => () => {}),
  onNavigate: vi.fn(() => () => {}),
    },
    projects: {
      select: vi.fn(),
      selectWorkspace: vi.fn(),
    },
  },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-1";
const WS_PATH = "/test/workspace";
const PANE_ID = "pane-1";
const TASK_ID = "agent-1";

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
    portlessEnabled: true,
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

function makeAgent(overrides?: Partial<AgentInfo>): AgentInfo {
  return {
    id: TASK_ID,
    agentSessionId: "session-1",
    name: "Test agent",
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

describe("navigateToAgent toast cleanup", () => {
  beforeEach(() => {
    markSeenMock.mockClear();
    useProjectStore.setState({ projects: [makeProject()], selectedProjectIndex: 0 });
    useAppStore.setState({
      activeWorkspacePath: WS_PATH,
      workspaceLayouts: { [WS_PATH]: makeLayout() },
    });
    useToastStore.setState({ toasts: [] });
    useAgentStore.setState({
      agents: [],
      unseenRespondedAgentIds: new Set(),
      unseenInputAgentIds: new Set(),
    });
  });

  it("removes the agent-input toast when navigating to the agent", () => {
    const toastId = `agent-input-${TASK_ID}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Agent needs input",
      status: "loading",
      persistent: true,
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    navigateToAgent(makeAgent());

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("is a no-op when no toast exists for the agent", () => {
    expect(useToastStore.getState().toasts).toHaveLength(0);

    navigateToAgent(makeAgent());

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does not remove toasts belonging to other agents", () => {
    const otherToastId = `agent-input-other-agent`;
    useToastStore.getState().addToast({
      id: otherToastId,
      message: "Agent needs input",
      status: "loading",
      persistent: true,
    });

    navigateToAgent(makeAgent());

    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].id).toBe(otherToastId);
  });

  it("does not remove toast when project is not found (early return)", () => {
    useProjectStore.setState({ projects: [] });
    const toastId = `agent-input-${TASK_ID}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Agent needs input",
      status: "loading",
      persistent: true,
    });

    navigateToAgent(makeAgent());

    // navigateToAgent returns early without reaching removeToast
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("does not remove toast when workspace is not found (early return)", () => {
    const toastId = `agent-input-${TASK_ID}`;
    useToastStore.getState().addToast({
      id: toastId,
      message: "Agent needs input",
      status: "loading",
      persistent: true,
    });

    navigateToAgent(makeAgent({ workspacePath: "/nonexistent/path" }));

    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
