import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // PTY
  ptyCreate: (paneId: string, cwd: string | null, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:create", paneId, cwd, cols, rows),
  ptyWrite: (paneId: string, data: string) =>
    ipcRenderer.invoke("pty:write", paneId, data),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:resize", paneId, cols, rows),
  ptyClose: (paneId: string) =>
    ipcRenderer.invoke("pty:close", paneId),
  ptyDetach: (paneId: string) =>
    ipcRenderer.invoke("pty:detach", paneId),

  // PTY events
  onPtyOutput: (paneId: string, callback: (data: string) => void) => {
    const channel = `pty-output-${paneId}`;
    const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
  onPtyExit: (paneId: string, callback: () => void) => {
    const channel = `pty-exit-${paneId}`;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
  onPtyCwd: (paneId: string, callback: (cwd: string) => void) => {
    const channel = `pty-cwd-${paneId}`;
    const listener = (_event: Electron.IpcRendererEvent, cwd: string) => callback(cwd);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },

  // Layout persistence
  saveLayout: (workspace: unknown) => ipcRenderer.invoke("layout:save", workspace),
  loadLayout: () => ipcRenderer.invoke("layout:load"),
  getRestoredSessions: () => ipcRenderer.invoke("layout:getRestoredSessions"),

  // Projects
  getProjects: () => ipcRenderer.invoke("projects:getAll"),
  getSelectedProjectIndex: () => ipcRenderer.invoke("projects:getSelectedIndex"),
  selectProject: (index: number) => ipcRenderer.invoke("projects:select", index),
  addProject: (name: string, path: string) => ipcRenderer.invoke("projects:add", name, path),
  removeProject: (projectId: string) => ipcRenderer.invoke("projects:remove", projectId),
  selectWorkspace: (projectId: string, workspaceIndex: number) =>
    ipcRenderer.invoke("projects:selectWorkspace", projectId, workspaceIndex),
  removeWorktree: (projectPath: string, worktreePath: string) =>
    ipcRenderer.invoke("projects:removeWorktree", projectPath, worktreePath),

  // Theme
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setSelectedTheme: (name: string) => ipcRenderer.invoke("theme:setSelected", name),
  getSelectedThemeName: () => ipcRenderer.invoke("theme:getSelectedName"),
  hasGhosttyConfig: () => ipcRenderer.invoke("theme:hasGhosttyConfig"),
  previewTheme: (name: string) => ipcRenderer.invoke("theme:preview", name),
  getAllThemeColors: () => ipcRenderer.invoke("theme:allColors"),

  // Port Scanner
  startPortScanner: () => ipcRenderer.invoke("ports:startScanner"),
  stopPortScanner: () => ipcRenderer.invoke("ports:stopScanner"),
  updateWorkspacePaths: (paths: string[]) => ipcRenderer.invoke("ports:updateWorkspacePaths", paths),
  scanPortsNow: () => ipcRenderer.invoke("ports:scanNow"),
  onPortsChanged: (callback: (ports: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ports: unknown[]) => callback(ports);
    ipcRenderer.on("ports-changed", listener);
    return () => { ipcRenderer.removeListener("ports-changed", listener); };
  },

  // GitHub
  getPrForBranch: (repoPath: string, branch: string) =>
    ipcRenderer.invoke("github:getPrForBranch", repoPath, branch),
  getPrsForBranches: (repoPath: string, branches: string[]) =>
    ipcRenderer.invoke("github:getPrsForBranches", repoPath, branches),

  // Dialog
  openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
});
