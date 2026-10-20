import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useProjectStore, type ProjectInfo } from "../project-store";
import {
  fakeLayoutApi,
  fakeViewportApi,
  queuedCommands,
  resetFakeLayoutServer,
  settled,
} from "./fake-layout-server";

// Mock electronAPI
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
    layout: fakeLayoutApi(),
    viewport: fakeViewportApi(),
    projects: {
      createWorktree: vi.fn(),
      selectWorkspace: vi.fn(),
      select: vi.fn(),
      onWorktreeSetupProgress: vi.fn(() => vi.fn()),
    },
    pty: {
      create: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      close: vi.fn(),
      onExit: vi.fn(() => vi.fn()),
      onCwd: vi.fn(() => vi.fn()),
      onOutput: vi.fn(() => vi.fn()),
    },
  },
});

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "proj-1",
    name: "test-project",
    path: "/repos/test-project",
    defaultBranch: "main",
    workspaces: [
      {
        path: "/repos/test-project",
        branch: "main",
        isMain: true,
        name: null,
        linkedIssues: [],
      },
    ],
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
    hostId: "local",
    folders: [],
    sidebarOrder: [],
    ...overrides,
  };
}

/** Seeds a project whose IPC returns it with one new workspace at `path`. */
function seedWorktree(project: ProjectInfo, path: string, branch: string) {
  useProjectStore.setState({ projects: [project] });
  vi.mocked(window.electronAPI.projects.createWorktree).mockResolvedValue({
    ...project,
    workspaces: [
      ...project.workspaces,
      { path, branch, isMain: false, name: branch, linkedIssues: [] },
    ],
  });
}

describe("createWorktree reports the agent pane id", () => {
  beforeEach(() => {
    resetFakeLayoutServer();
    useProjectStore.setState({ projects: [], selectedProjectIndex: 0 });
    useAppStore.setState({ workspaceLayouts: {}, activeWorkspacePath: null });
    vi.clearAllMocks();
  });

  it("calls onAgentPane with the pane of the agent tab opened for the prompt", async () => {
    const path = "/worktrees/test-project/prompted";
    seedWorktree(makeProject({ agentCommand: "codex" }), path, "prompted");
    const onAgentPane = vi.fn();

    await useProjectStore.getState().createWorktree("proj-1", "prompted", {
      branch: "prompted",
      agentPrompt: "Fix the bug",
      onAgentPane,
    });
    await settled();

    const agent = queuedCommands.find((c) => c.kind === "agent-startup");
    expect(agent).toBeDefined();
    expect(agent!.prompt).toBe("Fix the bug");
    expect(onAgentPane).toHaveBeenCalledTimes(1);
    expect(onAgentPane).toHaveBeenCalledWith(agent!.paneId);
  });

  it("does not call onAgentPane when there is no agent prompt", async () => {
    const path = "/worktrees/test-project/plain-agent";
    seedWorktree(makeProject(), path, "plain-agent");
    const onAgentPane = vi.fn();

    await useProjectStore.getState().createWorktree("proj-1", "plain-agent", {
      branch: "plain-agent",
      agentCommand: "claude",
      onAgentPane,
    });
    await settled();

    // The agent tab opens, but it carries no prompt, so nothing is reported.
    expect(queuedCommands).toContainEqual(
      expect.objectContaining({ text: "claude", kind: "agent-startup" }),
    );
    expect(onAgentPane).not.toHaveBeenCalled();
  });

  it("does not call onAgentPane when no tab is opened", async () => {
    const path = "/worktrees/test-project/bare";
    seedWorktree(makeProject(), path, "bare");
    const onAgentPane = vi.fn();

    await useProjectStore.getState().createWorktree("proj-1", "bare", {
      branch: "bare",
      onAgentPane,
    });
    await settled();

    expect(queuedCommands).toEqual([]);
    expect(onAgentPane).not.toHaveBeenCalled();
  });
});
