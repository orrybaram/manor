import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // PTY
  ptyCreate: (paneId: string, cwd: string | null, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:create", paneId, cwd, cols, rows),
  ptyWrite: (paneId: string, data: string) =>
    ipcRenderer.invoke("pty:write", paneId, data),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:resize", paneId, cols, rows),
  ptyClose: (paneId: string) => ipcRenderer.invoke("pty:close", paneId),
  ptyDetach: (paneId: string) => ipcRenderer.invoke("pty:detach", paneId),

  // PTY events
  onPtyOutput: (paneId: string, callback: (data: string) => void) => {
    const channel = `pty-output-${paneId}`;
    const listener = (_event: Electron.IpcRendererEvent, data: string) =>
      callback(data);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  onPtyExit: (paneId: string, callback: () => void) => {
    const channel = `pty-exit-${paneId}`;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  onPtyCwd: (paneId: string, callback: (cwd: string) => void) => {
    const channel = `pty-cwd-${paneId}`;
    const listener = (_event: Electron.IpcRendererEvent, cwd: string) =>
      callback(cwd);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  onPtyAgentStatus: (paneId: string, callback: (agent: unknown) => void) => {
    const channel = `pty-agent-status-${paneId}`;
    const listener = (_event: Electron.IpcRendererEvent, agent: unknown) =>
      callback(agent);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  // Layout persistence
  saveLayout: (workspace: unknown) =>
    ipcRenderer.invoke("layout:save", workspace),
  loadLayout: () => ipcRenderer.invoke("layout:load"),
  getRestoredSessions: () => ipcRenderer.invoke("layout:getRestoredSessions"),

  // Projects
  getProjects: () => ipcRenderer.invoke("projects:getAll"),
  getSelectedProjectIndex: () =>
    ipcRenderer.invoke("projects:getSelectedIndex"),
  selectProject: (index: number) =>
    ipcRenderer.invoke("projects:select", index),
  addProject: (name: string, path: string) =>
    ipcRenderer.invoke("projects:add", name, path),
  removeProject: (projectId: string) =>
    ipcRenderer.invoke("projects:remove", projectId),
  selectWorkspace: (projectId: string, workspaceIndex: number) =>
    ipcRenderer.invoke("projects:selectWorkspace", projectId, workspaceIndex),
  removeWorktree: (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) =>
    ipcRenderer.invoke(
      "projects:removeWorktree",
      projectId,
      worktreePath,
      deleteBranch,
    ),
  createWorktree: (projectId: string, name: string, branch?: string) =>
    ipcRenderer.invoke("projects:createWorktree", projectId, name, branch),
  renameWorkspace: (
    projectId: string,
    workspacePath: string,
    newName: string,
  ) =>
    ipcRenderer.invoke(
      "projects:renameWorkspace",
      projectId,
      workspacePath,
      newName,
    ),
  reorderWorkspaces: (projectId: string, orderedPaths: string[]) =>
    ipcRenderer.invoke("projects:reorderWorkspaces", projectId, orderedPaths),
  reorderProjects: (orderedIds: string[]) =>
    ipcRenderer.invoke("projects:reorder", orderedIds),
  updateProject: (
    projectId: string,
    updates: Partial<{
      name: string;
      defaultRunCommand: string | null;
      worktreePath: string | null;
      worktreeStartScript: string | null;
      worktreeTeardownScript: string | null;
      linearAssociations: Array<{
        teamId: string;
        teamName: string;
        teamKey: string;
      }>;
    }>,
  ) => ipcRenderer.invoke("projects:update", projectId, updates),

  // Theme
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setSelectedTheme: (name: string) =>
    ipcRenderer.invoke("theme:setSelected", name),
  getSelectedThemeName: () => ipcRenderer.invoke("theme:getSelectedName"),
  hasGhosttyConfig: () => ipcRenderer.invoke("theme:hasGhosttyConfig"),
  previewTheme: (name: string) => ipcRenderer.invoke("theme:preview", name),
  getAllThemeColors: () => ipcRenderer.invoke("theme:allColors"),

  // Port Scanner
  startPortScanner: () => ipcRenderer.invoke("ports:startScanner"),
  stopPortScanner: () => ipcRenderer.invoke("ports:stopScanner"),
  updateWorkspacePaths: (paths: string[]) =>
    ipcRenderer.invoke("ports:updateWorkspacePaths", paths),
  scanPortsNow: () => ipcRenderer.invoke("ports:scanNow"),
  onPortsChanged: (callback: (ports: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ports: unknown[]) =>
      callback(ports);
    ipcRenderer.on("ports-changed", listener);
    return () => {
      ipcRenderer.removeListener("ports-changed", listener);
    };
  },

  // Branch Watcher
  startBranchWatcher: (paths: string[]) =>
    ipcRenderer.invoke("branches:start", paths),
  stopBranchWatcher: () => ipcRenderer.invoke("branches:stop"),
  onBranchesChanged: (callback: (branches: Record<string, string>) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      branches: Record<string, string>,
    ) => callback(branches);
    ipcRenderer.on("branches-changed", listener);
    return () => {
      ipcRenderer.removeListener("branches-changed", listener);
    };
  },

  // GitHub
  getPrForBranch: (repoPath: string, branch: string) =>
    ipcRenderer.invoke("github:getPrForBranch", repoPath, branch),
  getPrsForBranches: (repoPath: string, branches: string[]) =>
    ipcRenderer.invoke("github:getPrsForBranches", repoPath, branches),

  // Linear
  linearConnect: (apiKey: string) =>
    ipcRenderer.invoke("linear:connect", apiKey),
  linearDisconnect: () => ipcRenderer.invoke("linear:disconnect"),
  linearIsConnected: () => ipcRenderer.invoke("linear:isConnected"),
  linearGetViewer: () => ipcRenderer.invoke("linear:getViewer"),
  linearGetTeams: () => ipcRenderer.invoke("linear:getTeams"),
  linearGetMyIssues: (
    teamIds: string[],
    options?: { stateTypes?: string[]; limit?: number },
  ) => ipcRenderer.invoke("linear:getMyIssues", teamIds, options),
  linearAutoMatch: () => ipcRenderer.invoke("linear:autoMatch"),

  // Dialog
  openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
});
