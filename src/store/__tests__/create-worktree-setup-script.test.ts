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
      workspaceSessions: {},
      activeWorkspacePath: null,
      pendingStartupCommands: {},
    });
    vi.clearAllMocks();
  });

  it("queues start script as pending startup command and auto-creates a session", async () => {
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

    // The start script should be queued as a pending startup command
    expect(
      useAppStore.getState().pendingStartupCommands[worktreePath],
    ).toBe("npm install");

    // A terminal session should be auto-created so the script actually runs
    const ws = useAppStore.getState().workspaceSessions[worktreePath];
    expect(ws).toBeDefined();
    expect(ws!.sessions.length).toBe(1);
  });

  it("combines start script and agent command when both provided", async () => {
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

    expect(
      useAppStore.getState().pendingStartupCommands[worktreePath],
    ).toBe("npm install && claude");
  });

  it("does not create a session when there is no startup command", async () => {
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

    // Workspace activated but no sessions created
    expect(useAppStore.getState().activeWorkspacePath).toBe(worktreePath);
    const ws = useAppStore.getState().workspaceSessions[worktreePath];
    expect(ws).toBeDefined();
    expect(ws!.sessions.length).toBe(0);
  });
});
