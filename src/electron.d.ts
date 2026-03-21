export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearAssociation {
  teamId: string;
  teamName: string;
  teamKey: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  priority: number;
  state: { name: string; type: string };
  labels: Array<{ name: string; color: string }>;
}

export interface LinearIssueDetail extends LinearIssue {
  description: string | null;
  labels: Array<{ id: string; name: string; color: string }>;
  assignee: {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
}

export interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
}

export type AgentKind = "claude" | "opencode" | "codex";
export type AgentStatus = "idle" | "running" | "waiting" | "complete" | "error";

export interface AgentState {
  kind: AgentKind | null;
  status: AgentStatus;
  processName: string | null;
  since: number;
}

/** Layout persistence types (mirrored from electron/terminal-host/layout-persistence.ts) */
export interface PersistedPaneSession {
  daemonSessionId: string;
  lastCwd: string | null;
  lastTitle: string | null;
}

export interface PersistedSession {
  id: string;
  title: string;
  rootNode: import("./store/pane-tree").PaneNode;
  focusedPaneId: string;
  paneSessions: Record<string, PersistedPaneSession>;
}

export interface PersistedWorkspace {
  workspacePath: string;
  sessions: PersistedSession[];
  selectedSessionId: string;
  pinnedSessionIds?: string[];
}

export interface PersistedLayout {
  version: 1;
  workspaces: PersistedWorkspace[];
}

export interface RestoredSessionsInfo {
  daemonSessions: Array<{
    sessionId: string;
    cwd: string | null;
    cols: number;
    rows: number;
    alive: boolean;
  }>;
  persistedSessionIds: string[];
}

export interface ElectronAPI {
  // PTY
  ptyCreate: (
    paneId: string,
    cwd: string | null,
    cols: number,
    rows: number,
  ) => Promise<{ ok: boolean; snapshot?: string | null }>;
  ptyWrite: (paneId: string, data: string) => Promise<void>;
  ptyResize: (paneId: string, cols: number, rows: number) => Promise<void>;
  ptyClose: (paneId: string) => Promise<void>;
  ptyDetach: (paneId: string) => Promise<void>;

  // PTY events (return unsubscribe function)
  onPtyOutput: (paneId: string, callback: (data: string) => void) => () => void;
  onPtyExit: (paneId: string, callback: () => void) => () => void;
  onPtyCwd: (paneId: string, callback: (cwd: string) => void) => () => void;
  onPtyAgentStatus: (
    paneId: string,
    callback: (agent: AgentState) => void,
  ) => () => void;

  // Layout persistence
  saveLayout: (workspace: PersistedWorkspace) => Promise<void>;
  loadLayout: () => Promise<PersistedLayout | null>;
  getRestoredSessions: () => Promise<RestoredSessionsInfo>;

  // Projects
  getProjects: () => Promise<import("./store/project-store").ProjectInfo[]>;
  getSelectedProjectIndex: () => Promise<number>;
  selectProject: (index: number) => Promise<void>;
  addProject: (
    name: string,
    path: string,
  ) => Promise<import("./store/project-store").ProjectInfo>;
  removeProject: (projectId: string) => Promise<void>;
  selectWorkspace: (projectId: string, workspaceIndex: number) => Promise<void>;
  removeWorktree: (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) => Promise<void>;
  createWorktree: (
    projectId: string,
    name: string,
    branch?: string,
  ) => Promise<import("./store/project-store").ProjectInfo | null>;
  renameWorkspace: (
    projectId: string,
    workspacePath: string,
    newName: string,
  ) => Promise<void>;
  reorderWorkspaces: (
    projectId: string,
    orderedPaths: string[],
  ) => Promise<void>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  updateProject: (
    projectId: string,
    updates: import("./store/project-store").ProjectUpdatableFields,
  ) => Promise<import("./store/project-store").ProjectInfo | null>;

  // Theme
  getTheme: () => Promise<import("./store/theme-store").Theme>;
  setSelectedTheme: (
    name: string,
  ) => Promise<import("./store/theme-store").Theme>;
  getSelectedThemeName: () => Promise<string>;
  hasGhosttyConfig: () => Promise<boolean>;
  previewTheme: (
    name: string,
  ) => Promise<import("./store/theme-store").Theme | null>;
  getAllThemeColors: () => Promise<
    Record<
      string,
      Pick<
        import("./store/theme-store").Theme,
        | "red"
        | "green"
        | "yellow"
        | "blue"
        | "magenta"
        | "cyan"
        | "background"
        | "foreground"
      >
    >
  >;

  // Port Scanner
  startPortScanner: () => Promise<void>;
  stopPortScanner: () => Promise<void>;
  updateWorkspacePaths: (paths: string[]) => Promise<void>;
  scanPortsNow: () => Promise<ActivePort[]>;
  onPortsChanged: (callback: (ports: ActivePort[]) => void) => () => void;

  // Branch Watcher
  startBranchWatcher: (paths: string[]) => Promise<void>;
  stopBranchWatcher: () => Promise<void>;
  onBranchesChanged: (
    callback: (branches: Record<string, string>) => void,
  ) => () => void;

  // Diff Watcher
  startDiffWatcher: (workspaces: Record<string, string>) => Promise<void>;
  stopDiffWatcher: () => Promise<void>;
  onDiffsChanged: (
    callback: (diffs: Record<string, { added: number; removed: number }>) => void,
  ) => () => void;

  // GitHub
  getPrForBranch: (repoPath: string, branch: string) => Promise<unknown>;
  getPrsForBranches: (
    repoPath: string,
    branches: string[],
  ) => Promise<[string, { number: number; state: string; title: string; url: string } | null][]>;

  // Linear
  linearConnect: (apiKey: string) => Promise<{ name: string; email: string }>;
  linearDisconnect: () => Promise<void>;
  linearIsConnected: () => Promise<boolean>;
  linearGetViewer: () => Promise<{ name: string; email: string }>;
  linearGetTeams: () => Promise<LinearTeam[]>;
  linearGetMyIssues: (
    teamIds: string[],
    options?: { stateTypes?: string[]; limit?: number },
  ) => Promise<LinearIssue[]>;
  linearGetIssueDetail: (issueId: string) => Promise<LinearIssueDetail>;
  linearAutoMatch: () => Promise<Record<string, LinearAssociation>>;

  // Dialog
  openDirectory: () => Promise<string | null>;

  // Shell
  openExternal: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
