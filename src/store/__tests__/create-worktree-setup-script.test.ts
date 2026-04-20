import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useProjectStore, type ProjectInfo } from "../project-store";

// Mock electronAPI
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
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
    ...overrides,
  };
}

describe("createWorktree setup script", () => {
  beforeEach(() => {
    // Reset stores
    useProjectStore.setState({
      projects: [],
      selectedProjectIndex: 0,
    });
    useAppStore.setState({
      workspaceLayouts: {},
      activeWorkspacePath: null,
      pendingStartupCommands: {},
    });
    vi.clearAllMocks();
  });

  it("stores start script in worktree setup state (not pending startup commands)", async () => {
    const worktreePath = "/worktrees/test-project/my-feature";

    const projectWithScript = makeProject({
      worktreeStartScript: "npm install",
    });

    // Seed the store with the project
    useProjectStore.setState({ projects: [projectWithScript] });

    // Mock IPC to return project with the new workspace added
    const updatedProject: ProjectInfo = {
      ...projectWithScript,
      workspaces: [
        ...projectWithScript.workspaces,
        {
          path: worktreePath,
          branch: "my-feature",
          isMain: false,
          name: "my-feature",
          linkedIssues: [],
        },
      ],
    };
    vi.mocked(window.electronAPI.projects.createWorktree).mockResolvedValue(
      updatedProject,
    );

    // Create the worktree
    const result = await useProjectStore
      .getState()
      .createWorktree("proj-1", "my-feature", "my-feature");

    expect(result).toBe(worktreePath);

    // The workspace should be activated
    expect(useAppStore.getState().activeWorkspacePath).toBe(worktreePath);

    // Start script is stored in worktreeSetupState, not pendingStartupCommands
    const setupState = useAppStore.getState().worktreeSetupState[worktreePath];
    expect(setupState).toBeDefined();
    expect(setupState.startScript).toBe("npm install");

    // No pending startup command is set (setup view handles execution)
    expect(
      useAppStore.getState().pendingStartupCommands[worktreePath],
    ).toBeUndefined();
  });

  it("stores setup-script step as pending when both start script and agent command provided", async () => {
    const worktreePath = "/worktrees/test-project/feat";

    const projectWithScript = makeProject({
      worktreeStartScript: "npm install",
    });
    useProjectStore.setState({ projects: [projectWithScript] });

    const updatedProject: ProjectInfo = {
      ...projectWithScript,
      workspaces: [
        ...projectWithScript.workspaces,
        {
          path: worktreePath,
          branch: "feat",
          isMain: false,
          name: "feat",
          linkedIssues: [],
        },
      ],
    };
    vi.mocked(window.electronAPI.projects.createWorktree).mockResolvedValue(
      updatedProject,
    );

    await useProjectStore
      .getState()
      .createWorktree("proj-1", "feat", "feat", "claude");

    // Setup state should exist with a setup-script step marked pending
    const setupState = useAppStore.getState().worktreeSetupState[worktreePath];
    expect(setupState).toBeDefined();
    const setupScriptStep = setupState.steps.find((s: any) => s.step === "setup-script");
    expect(setupScriptStep).toBeDefined();
    expect(setupScriptStep!.status).toBe("pending");
  });

  it("does not create a tab when there is no startup command", async () => {
    const worktreePath = "/worktrees/test-project/plain";

    const project = makeProject(); // no start script, no agent command
    useProjectStore.setState({ projects: [project] });

    const updatedProject: ProjectInfo = {
      ...project,
      workspaces: [
        ...project.workspaces,
        {
          path: worktreePath,
          branch: "plain",
          isMain: false,
          name: "plain",
          linkedIssues: [],
        },
      ],
    };
    vi.mocked(window.electronAPI.projects.createWorktree).mockResolvedValue(
      updatedProject,
    );

    await useProjectStore
      .getState()
      .createWorktree("proj-1", "plain", "plain");

    // Workspace activated but no tabs created
    expect(useAppStore.getState().activeWorkspacePath).toBe(worktreePath);
    const layout = useAppStore.getState().workspaceLayouts[worktreePath];
    expect(layout).toBeDefined();
    const panel = layout!.panels[layout!.activePanelId];
    expect(panel).toBeDefined();
    expect(panel!.tabs.length).toBe(0);
  });
});
