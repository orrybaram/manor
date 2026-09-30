/** Fully typed store fixtures for tests; override only what a test cares about. */
import type { AgentInfo } from "../electron.d";
import type { ProjectInfo } from "../store/project-store";

export function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    agentSessionId: "session-1",
    name: null,
    status: "active",
    createdAt: "2026-09-30T00:00:00Z",
    updatedAt: "2026-09-30T00:00:00Z",
    completedAt: null,
    activatedAt: null,
    projectId: "p1",
    projectName: "Project One",
    hostId: "local",
    workspacePath: "/repo/p1",
    cwd: "/repo/p1",
    agentKind: "claude",
    agentCommand: null,
    paneId: null,
    lastAgentStatus: null,
    resumedAt: null,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    name: "Project One",
    path: "/repo/p1",
    defaultBranch: "main",
    workspaces: [],
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
