import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import {
  useProjectStore,
  type ProjectInfo,
  type SetupProgressEvent,
} from "../project-store";
import { useToastStore } from "../toast-store";
import {
  fakeLayoutApi,
  fakeViewportApi,
  queuedCommands,
  settled,
} from "./fake-layout-server";

/** Every live `projects.onWorktreeSetupProgress` listener. */
const progressListeners = new Set<(e: SetupProgressEvent) => void>();
/** The server reporting a setup-script step (ADR-227 D5). */
function serverReports(event: SetupProgressEvent): void {
  for (const cb of [...progressListeners]) cb(event);
}

// Mock electronAPI
vi.stubGlobal("window", {
  ...globalThis.window,
  electronAPI: {
    // The Manor server's layout store, in-process (ADR-179 D1).
    layout: fakeLayoutApi(),
    viewport: fakeViewportApi(),
    projects: {
      createWorktree: vi.fn(),
      selectWorkspace: vi.fn(),
      select: vi.fn(),
      onWorktreeSetupProgress: vi.fn((cb: (e: SetupProgressEvent) => void) => {
        progressListeners.add(cb);
        return () => progressListeners.delete(cb);
      }),
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
    });
    useToastStore.setState({ toasts: [] });
    progressListeners.clear();
    vi.clearAllMocks();
  });

  it("leaves the setup script to the server and follows it to the end", async () => {
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
      .createWorktree("proj-1", "my-feature", { branch: "my-feature" });

    expect(result).toBe(worktreePath);

    // The workspace should be activated
    expect(useAppStore.getState().activeWorkspacePath).toBe(worktreePath);

    // The renderer neither queues the script nor spawns a session for it:
    // the server opened the script's tab before answering (ADR-227 D5).
    expect(queuedCommands).toEqual([]);
    expect(window.electronAPI.pty.create).not.toHaveBeenCalled();
    expect(useAppStore.getState().worktreeSetupState[worktreePath]).toBeUndefined();

    // Another workspace's script ending is not this one's.
    serverReports({
      step: "setup-script",
      status: "done",
      workspacePath: "/worktrees/test-project/other",
    });
    expect(useToastStore.getState().toasts).toEqual([]);

    serverReports({ step: "setup-script", status: "done", workspacePath: worktreePath });
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Workspace setup complete" }),
    ]);
    expect(progressListeners.size).toBe(0);
  });

  it("keeps a script that ended before the answer for the workspace it made", async () => {
    const worktreePath = "/worktrees/test-project/quick";
    const project = makeProject({ worktreeStartScript: "true" });
    useProjectStore.setState({ projects: [project] });
    vi.mocked(window.electronAPI.projects.createWorktree).mockImplementation(
      async () => {
        serverReports({ step: "setup-script", status: "done", workspacePath: worktreePath });
        return {
          ...project,
          workspaces: [
            ...project.workspaces,
            { path: worktreePath, branch: "quick", isMain: false, name: "quick", linkedIssues: [] },
          ],
        };
      },
    );

    await useProjectStore.getState().createWorktree("proj-1", "quick", { branch: "quick" });

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Workspace setup complete" }),
    ]);
  });

  it("shows the script's progress as a toast while the agent's tab is on screen", async () => {
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
      .createWorktree("proj-1", "feat", { branch: "feat", agentCommand: "claude" });

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ id: `worktree-setup-${worktreePath}`, status: "loading" }),
    ]);

    // The agent starts in parallel with the script, not after it: its launch
    // line is queued on the server for a tab of its own (ADR-179 ticket 11).
    expect(queuedCommands).toContainEqual(
      expect.objectContaining({ text: "claude", kind: "agent-startup" }),
    );
    // The tab arrives with the server's broadcast (ADR-182 D9).
    await settled();
    const layout = useAppStore.getState().workspaceLayouts[worktreePath];
    const tabs = Object.values(layout!.panels).flatMap((p) => p.tabs);
    expect(tabs.length).toBe(1);

    serverReports({ step: "setup-script", status: "done", workspacePath: worktreePath });
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Workspace setup complete" }),
    ]);
  });

  it("starts the project's agent with the prompt as its first message", async () => {
    const worktreePath = "/worktrees/test-project/prompted";

    const project = { ...makeProject(), agentCommand: "codex" };
    useProjectStore.setState({ projects: [project] });
    vi.mocked(window.electronAPI.projects.createWorktree).mockResolvedValue({
      ...project,
      workspaces: [
        ...project.workspaces,
        {
          path: worktreePath,
          branch: "prompted",
          isMain: false,
          name: "prompted",
          linkedIssues: [],
        },
      ],
    });

    await useProjectStore.getState().createWorktree("proj-1", "prompted", {
      branch: "prompted",
      agentPrompt: 'Fix "the" bug\nin $HOME',
    });

    expect(queuedCommands).toContainEqual(
      expect.objectContaining({
        text: "codex",
        kind: "agent-startup",
        prompt: 'Fix "the" bug\nin $HOME',
      }),
    );
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
      .createWorktree("proj-1", "plain", { branch: "plain" });

    // Workspace activated, and nothing was sent to create a tab in it: a
    // workspace with no layout at all is what the empty state renders from
    // (ADR-179 D1 — the server makes one for the first command, and there
    // was no first command).
    expect(useAppStore.getState().activeWorkspacePath).toBe(worktreePath);
    expect(
      useAppStore.getState().workspaceLayouts[worktreePath],
    ).toBeUndefined();
  });
});
