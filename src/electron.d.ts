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
  pty: {
    create: (
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
    ) => Promise<{ ok: boolean; snapshot?: string | null }>;
    write: (paneId: string, data: string) => Promise<void>;
    resize: (paneId: string, cols: number, rows: number) => Promise<void>;
    close: (paneId: string) => Promise<void>;
    detach: (paneId: string) => Promise<void>;
    onOutput: (paneId: string, callback: (data: string) => void) => () => void;
    onExit: (paneId: string, callback: () => void) => () => void;
    onCwd: (paneId: string, callback: (cwd: string) => void) => () => void;
    onAgentStatus: (
      paneId: string,
      callback: (agent: AgentState) => void,
    ) => () => void;
  };

  layout: {
    save: (workspace: PersistedWorkspace) => Promise<void>;
    load: () => Promise<PersistedLayout | null>;
    getRestoredSessions: () => Promise<RestoredSessionsInfo>;
  };

  projects: {
    getAll: () => Promise<import("./store/project-store").ProjectInfo[]>;
    getSelectedIndex: () => Promise<number>;
    select: (index: number) => Promise<void>;
    add: (
      name: string,
      path: string,
    ) => Promise<import("./store/project-store").ProjectInfo>;
    remove: (projectId: string) => Promise<void>;
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
    reorder: (orderedIds: string[]) => Promise<void>;
    update: (
      projectId: string,
      updates: import("./store/project-store").ProjectUpdatableFields,
    ) => Promise<import("./store/project-store").ProjectInfo | null>;
  };

  theme: {
    get: () => Promise<import("./store/theme-store").Theme>;
    setSelected: (
      name: string,
    ) => Promise<import("./store/theme-store").Theme>;
    getSelectedName: () => Promise<string>;
    hasGhosttyConfig: () => Promise<boolean>;
    preview: (
      name: string,
    ) => Promise<import("./store/theme-store").Theme | null>;
    allColors: () => Promise<
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
  };

  ports: {
    startScanner: () => Promise<void>;
    stopScanner: () => Promise<void>;
    updateWorkspacePaths: (paths: string[]) => Promise<void>;
    scanNow: () => Promise<ActivePort[]>;
    onChange: (callback: (ports: ActivePort[]) => void) => () => void;
  };

  branches: {
    start: (paths: string[]) => Promise<void>;
    stop: () => Promise<void>;
    onChange: (
      callback: (branches: Record<string, string>) => void,
    ) => () => void;
  };

  diffs: {
    start: (workspaces: Record<string, string>) => Promise<void>;
    stop: () => Promise<void>;
    onChange: (
      callback: (diffs: Record<string, { added: number; removed: number }>) => void,
    ) => () => void;
  };

  github: {
    getPrForBranch: (repoPath: string, branch: string) => Promise<unknown>;
    getPrsForBranches: (
      repoPath: string,
      branches: string[],
    ) => Promise<[string, { number: number; state: string; title: string; url: string } | null][]>;
  };

  linear: {
    connect: (apiKey: string) => Promise<{ name: string; email: string }>;
    disconnect: () => Promise<void>;
    isConnected: () => Promise<boolean>;
    getViewer: () => Promise<{ name: string; email: string }>;
    getTeams: () => Promise<LinearTeam[]>;
    getMyIssues: (
      teamIds: string[],
      options?: { stateTypes?: string[]; limit?: number },
    ) => Promise<LinearIssue[]>;
    getIssueDetail: (issueId: string) => Promise<LinearIssueDetail>;
    autoMatch: () => Promise<Record<string, LinearAssociation>>;
  };

  dialog: {
    openDirectory: () => Promise<string | null>;
  };

  shell: {
    openExternal: (url: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
