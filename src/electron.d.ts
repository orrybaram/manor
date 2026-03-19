export interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
}

/** Layout persistence types (mirrored from electron/terminal-host/layout-persistence.ts) */
export interface PersistedPaneSession {
  daemonSessionId: string;
  lastCwd: string | null;
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
  ptyCreate: (paneId: string, cwd: string | null, cols: number, rows: number) => Promise<void>;
  ptyWrite: (paneId: string, data: string) => Promise<void>;
  ptyResize: (paneId: string, cols: number, rows: number) => Promise<void>;
  ptyClose: (paneId: string) => Promise<void>;
  ptyDetach: (paneId: string) => Promise<void>;

  // PTY events (return unsubscribe function)
  onPtyOutput: (paneId: string, callback: (data: string) => void) => () => void;
  onPtyExit: (paneId: string, callback: () => void) => () => void;
  onPtyCwd: (paneId: string, callback: (cwd: string) => void) => () => void;

  // Layout persistence
  saveLayout: (workspace: PersistedWorkspace) => Promise<void>;
  loadLayout: () => Promise<PersistedLayout | null>;
  getRestoredSessions: () => Promise<RestoredSessionsInfo>;

  // Projects
  getProjects: () => Promise<import("./store/project-store").ProjectInfo[]>;
  getSelectedProjectIndex: () => Promise<number>;
  selectProject: (index: number) => Promise<void>;
  addProject: (name: string, path: string) => Promise<import("./store/project-store").ProjectInfo>;
  removeProject: (projectId: string) => Promise<void>;
  selectWorkspace: (projectId: string, workspaceIndex: number) => Promise<void>;
  removeWorktree: (projectPath: string, worktreePath: string) => Promise<void>;

  // Theme
  getTheme: () => Promise<import("./store/theme-store").Theme>;
  setSelectedTheme: (name: string) => Promise<import("./store/theme-store").Theme>;
  getSelectedThemeName: () => Promise<string>;
  hasGhosttyConfig: () => Promise<boolean>;
  previewTheme: (name: string) => Promise<import("./store/theme-store").Theme | null>;
  getAllThemeColors: () => Promise<Record<string, Pick<import("./store/theme-store").Theme, "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "background" | "foreground">>>;

  // Port Scanner
  startPortScanner: () => Promise<void>;
  stopPortScanner: () => Promise<void>;
  updateWorkspacePaths: (paths: string[]) => Promise<void>;
  scanPortsNow: () => Promise<ActivePort[]>;
  onPortsChanged: (callback: (ports: ActivePort[]) => void) => () => void;

  // GitHub
  getPrForBranch: (repoPath: string, branch: string) => Promise<unknown>;
  getPrsForBranches: (repoPath: string, branches: string[]) => Promise<unknown>;

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
