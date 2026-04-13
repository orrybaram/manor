export interface AppPreferences {
  dockBadgeEnabled: boolean;
  notifyOnResponse: boolean;
  notifyOnRequiresInput: boolean;
  notificationSound: string | false;
  defaultEditor: string;
  editorIsTerminal: boolean;
  diffOpensInNewPanel: boolean;
}

export type TaskStatus = "active" | "completed" | "error" | "abandoned";

export interface TaskInfo {
  id: string;
  agentSessionId: string;
  name: string | null;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  activatedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  workspacePath: string | null;
  cwd: string;
  agentKind: "claude" | "opencode" | "codex";
  agentCommand: string | null;
  paneId: string | null;
  lastAgentStatus: string | null;
}

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

export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
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

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
}

export interface GitHubIssueDetail extends GitHubIssue {
  body: string | null;
  milestone: { title: string } | null;
}

export interface ActivePort {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
  hostname: string | null;
}

export interface ManorProcessInfo {
  daemon: {
    pid: number | null;
    alive: boolean;
  };
  internalServers: Array<{
    name: string;
    port: number | null;
  }>;
  sessions: Array<{
    sessionId: string;
    alive: boolean;
    cwd: string | null;
    /** True when the session is alive in the daemon but has no matching pane in the layout */
    orphaned: boolean;
  }>;
  ports: ActivePort[];
}

export type AgentKind = "claude" | "opencode" | "codex" | "pi";
export type AgentStatus =
  | "idle"
  | "thinking"
  | "working"
  | "complete"
  | "requires_input"
  | "error"
  | "responded";

export interface AgentState {
  kind: AgentKind | null;
  status: AgentStatus;
  processName: string | null;
  since: number;
  title: string | null;
}

/** Layout persistence types (mirrored from electron/terminal-host/layout-persistence.ts) */
export interface PersistedPaneSession {
  daemonSessionId: string;
  lastCwd: string | null;
  lastTitle: string | null;
  lastAgentStatus?: AgentState | null;
}

export interface PersistedTab {
  id: string;
  title: string;
  rootNode: import("./store/pane-tree").PaneNode;
  focusedPaneId: string;
  paneSessions: Record<string, PersistedPaneSession>;
}

/** V1 persisted workspace (kept for migration reference) */
export interface PersistedWorkspaceV1 {
  workspacePath: string;
  tabs: PersistedTab[];
  selectedTabId: string;
  pinnedTabIds?: string[];
}

/** V1 persisted layout (kept for migration reference) */
export interface PersistedLayoutV1 {
  version: 1;
  workspaces: PersistedWorkspaceV1[];
}

/** Persisted panel (v2) */
export interface PersistedPanel {
  id: string;
  tabs: PersistedTab[];
  selectedTabId: string;
  pinnedTabIds: string[];
}

/** Persisted workspace state (v2) */
export interface PersistedWorkspace {
  workspacePath: string;
  panelTree: import("./store/panel-tree").PanelNode;
  panels: Record<string, PersistedPanel>;
  activePanelId: string;
}

/** Full persisted layout (v2) */
export interface PersistedLayout {
  version: 2;
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
    ) => Promise<{ ok: boolean; snapshot?: string | null; error?: string; prewarmed?: boolean }>;
    write: (paneId: string, data: string) => Promise<void>;
    resize: (paneId: string, cols: number, rows: number) => Promise<void>;
    close: (paneId: string) => Promise<void>;
    reset: (
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
    ) => Promise<{ ok: boolean; snapshot?: string | null; error?: string; prewarmed?: boolean }>;
    detach: (paneId: string) => Promise<void>;
    consumePrewarmed: () => Promise<{ paneId: string; commandInjected: boolean } | null>;
    updatePrewarmCwd: (cwd: string, agentCommand?: string | null) => Promise<void>;
    onOutput: (paneId: string, callback: (data: string) => void) => () => void;
    onExit: (paneId: string, callback: () => void) => () => void;
    onCwd: (paneId: string, callback: (cwd: string) => void) => () => void;
    onAgentStatus: (
      paneId: string,
      callback: (agent: AgentState) => void,
    ) => () => void;
    onError: (paneId: string, callback: (message: string) => void) => () => void;
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
    selectWorkspace: (
      projectId: string,
      workspaceIndex: number,
    ) => Promise<void>;
    removeWorktree: (
      projectId: string,
      worktreePath: string,
      deleteBranch?: boolean,
    ) => Promise<void>;
    onRemoveWorktreeProgress: (callback: (step: string) => void) => () => void;
    onWorktreeSetupProgress: (callback: (event: import("./store/project-store").SetupProgressEvent) => void) => () => void;
    canQuickMerge: (
      projectId: string,
      worktreePath: string,
    ) => Promise<{ canMerge: boolean; reason?: string }>;
    quickMergeWorktree: (
      projectId: string,
      worktreePath: string,
    ) => Promise<void>;
    createWorktree: (
      projectId: string,
      name: string,
      branch?: string,
      linkedIssue?: import("./store/project-store").LinkedIssue,
      baseBranch?: string,
      useExistingBranch?: boolean,
    ) => Promise<import("./store/project-store").ProjectInfo | null>;
    convertMainToWorktree: (
      projectId: string,
      name: string,
    ) => Promise<import("./store/project-store").ProjectInfo | null>;
    listRemoteBranches: (projectId: string) => Promise<string[]>;
    listLocalBranches: (projectId: string) => Promise<string[]>;
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
    setSelected: (name: string) => Promise<import("./store/theme-store").Theme>;
    getSelectedName: () => Promise<string>;
    hasGhosttyConfig: () => Promise<boolean>;
    preview: (name: string) => Promise<import("./store/theme-store").Theme>;
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
    updateWorkspaceMetadata: (
      meta: Array<{
        path: string;
        projectName: string | null;
        branch: string | null;
        isMain: boolean;
      }>,
    ) => Promise<void>;
    killPort: (pid: number) => Promise<void>;
    scanNow: () => Promise<ActivePort[]>;
    onChange: (callback: (ports: ActivePort[]) => void) => () => void;
  };

  processes: {
    list: () => Promise<ManorProcessInfo>;
    killSession: (sessionId: string) => Promise<void>;
    cleanupDead: () => Promise<{ success: boolean }>;
    killDaemon: () => Promise<void>;
    killAll: () => Promise<void>;
    restartPortless: () => Promise<void>;
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
      callback: (
        diffs: Record<string, { added: number; removed: number }>,
      ) => void,
    ) => () => void;
    getFullDiff: (
      wsPath: string,
      defaultBranch: string,
    ) => Promise<string | null>;
    getLocalDiff: (wsPath: string) => Promise<string | null>;
    getStagedFiles: (wsPath: string) => Promise<string[]>;
  };

  git: {
    stage: (wsPath: string, files: string[]) => Promise<void>;
    unstage: (wsPath: string, files: string[]) => Promise<void>;
    discard: (wsPath: string, files: string[]) => Promise<void>;
    stash: (wsPath: string, files: string[]) => Promise<void>;
    commit: (wsPath: string, message: string, flags: string[]) => Promise<void>;
  };

  github: {
    getPrForBranch: (repoPath: string, branch: string) => Promise<unknown>;
    getPrsForBranches: (
      repoPath: string,
      branches: string[],
    ) => Promise<
      [
        string,
        {
          number: number;
          state: string;
          title: string;
          url: string;
          isDraft?: boolean;
          additions?: number;
          deletions?: number;
          reviewDecision?: string | null;
          checks?: {
            total: number;
            passing: number;
            failing: number;
            pending: number;
          } | null;
          unresolvedThreads?: number;
        } | null,
      ][]
    >;
    checkStatus: () => Promise<{
      installed: boolean;
      authenticated: boolean;
      username?: string;
    }>;
    getMyIssues: (repoPath: string, limit?: number, state?: "open" | "closed" | "all") => Promise<GitHubIssue[]>;
    getAllIssues: (repoPath: string, limit?: number, state?: "open" | "closed" | "all") => Promise<GitHubIssue[]>;
    getIssueDetail: (
      repoPath: string,
      issueNumber: number,
    ) => Promise<GitHubIssueDetail>;
    assignIssue: (repoPath: string, issueNumber: number) => Promise<void>;
    closeIssue: (repoPath: string, issueNumber: number) => Promise<void>;
    createIssue: (
      title: string,
      body: string,
      labels: string[],
    ) => Promise<{ url: string } | null>;
    uploadFeedbackImages: (
      images: { base64: string; name: string }[],
    ) => Promise<string[]>;
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
    getAllIssues: (
      teamIds: string[],
      options?: { stateTypes?: string[]; limit?: number },
    ) => Promise<LinearIssue[]>;
    proxyImage: (url: string) => Promise<string>;
    autoMatch: () => Promise<Record<string, LinearAssociation>>;
    startIssue: (issueId: string) => Promise<void>;
    closeIssue: (issueId: string) => Promise<void>;
    linkIssueToWorkspace: (
      projectId: string,
      workspacePath: string,
      issue: LinkedIssue,
    ) => Promise<void>;
    unlinkIssueFromWorkspace: (
      projectId: string,
      workspacePath: string,
      issueId: string,
    ) => Promise<void>;
  };

  updater: {
    checkForUpdates: () => Promise<void>;
    quitAndInstall: () => Promise<void>;
    onUpdateAvailable: (
      callback: (info: { version: string }) => void,
    ) => () => void;
    onUpdateDownloaded: (
      callback: (info: { version: string }) => void,
    ) => () => void;
    onDownloadProgress: (
      callback: (progress: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      }) => void,
    ) => () => void;
    onError: (callback: (message: string) => void) => () => void;
  };

  dialog: {
    openDirectory: () => Promise<string | null>;
  };

  shell: {
    openExternal: (url: string) => Promise<void>;
    openInEditor: (path: string) => Promise<string>;
    resolveFilePath: (filePath: string, cwd: string) => Promise<string | null>;
    discoverAgents: () => Promise<Array<{ name: string; command: string }>>;
  };

  tasks: {
    getAll: (opts?: {
      projectId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    }) => Promise<TaskInfo[]>;
    get: (taskId: string) => Promise<TaskInfo | null>;
    update: (
      taskId: string,
      updates: Partial<TaskInfo>,
    ) => Promise<TaskInfo | null>;
    delete: (taskId: string) => Promise<boolean>;
    setPaneContext: (
      paneId: string,
      context: {
        projectId: string;
        projectName: string;
        workspacePath: string;
        agentCommand: string | null;
      },
    ) => Promise<void>;
    markSeen: (taskId: string) => Promise<void>;
    onUpdate: (callback: (task: TaskInfo) => void) => () => void;
  };

  preferences: {
    getAll: () => Promise<AppPreferences>;
    set: (
      key: keyof AppPreferences,
      value: AppPreferences[keyof AppPreferences],
    ) => Promise<void>;
    onChange: (callback: (prefs: AppPreferences) => void) => () => void;
    playSound: (name: string) => Promise<void>;
  };

  keybindings: {
    getAll: () => Promise<Record<string, string>>;
    set: (commandId: string, combo: string) => Promise<void>;
    reset: (commandId: string) => Promise<void>;
    resetAll: () => Promise<void>;
    onChange: (
      callback: (overrides: Record<string, string>) => void,
    ) => () => void;
  };

  notifications: {
    onNavigateToTask: (callback: (taskId: string) => void) => () => void;
  };

  clipboard: {
    writeText: (text: string) => Promise<void>;
  };

  webview: {
    register: (paneId: string, webContentsId: number) => Promise<void>;
    unregister: (paneId: string) => Promise<void>;
    startPicker: (paneId: string) => Promise<void>;
    cancelPicker: (paneId: string) => Promise<void>;
    zoomIn: (paneId: string) => Promise<void>;
    zoomOut: (paneId: string) => Promise<void>;
    zoomReset: (paneId: string) => Promise<void>;
    onPickerResult: (
      callback: (paneId: string, result: PickedElementResult) => void,
    ) => () => void;
    onPickerCancel: (callback: (paneId: string) => void) => () => void;
    onEscape: (callback: (paneId: string) => void) => () => void;
    onFocusUrl: (callback: (paneId: string) => void) => () => void;
    onNewWindow: (
      callback: (paneId: string, url: string) => void,
    ) => () => void;
    stop: (paneId: string) => Promise<void>;
    findInPage: (paneId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) => Promise<void>;
    stopFindInPage: (paneId: string) => Promise<void>;
    onLoadingChanged: (callback: (paneId: string, isLoading: boolean) => void) => () => void;
    onFaviconUpdated: (callback: (paneId: string, faviconUrl: string) => void) => () => void;
    onFindResult: (callback: (paneId: string, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => () => void;
    onFind: (callback: (paneId: string) => void) => () => void;
    onGoBack: (callback: (paneId: string) => void) => () => void;
    onGoForward: (callback: (paneId: string) => void) => () => void;
    setAudioMuted: (paneId: string, muted: boolean) => Promise<void>;
    onAudioStateChanged: (callback: (paneId: string, audible: boolean) => void) => () => void;
  };
}

export interface PickedElementResult {
  outerHTML: string;
  selector: string;
  computedStyles: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number };
  accessibility: Record<string, string>;
  reactComponents?: Array<{
    name: string;
    source?: { fileName: string; lineNumber: number };
  }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
