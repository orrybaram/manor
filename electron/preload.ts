import { contextBridge, ipcRenderer } from "electron";

function onChannel<T>(
  channel: string,
  callback: (value: T) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("electronAPI", {
  pty: {
    create: (paneId: string, cwd: string | null, cols: number, rows: number) =>
      ipcRenderer.invoke("pty:create", paneId, cwd, cols, rows),
    write: (paneId: string, data: string) =>
      ipcRenderer.invoke("pty:write", paneId, data),
    resize: (paneId: string, cols: number, rows: number) =>
      ipcRenderer.invoke("pty:resize", paneId, cols, rows),
    close: (paneId: string) => ipcRenderer.invoke("pty:close", paneId),
    detach: (paneId: string) => ipcRenderer.invoke("pty:detach", paneId),
    onOutput: (paneId: string, callback: (data: string) => void) =>
      onChannel(`pty-output-${paneId}`, callback),
    onExit: (paneId: string, callback: () => void) =>
      onChannel(`pty-exit-${paneId}`, callback),
    onCwd: (paneId: string, callback: (cwd: string) => void) =>
      onChannel(`pty-cwd-${paneId}`, callback),
    onAgentStatus: (paneId: string, callback: (agent: unknown) => void) =>
      onChannel(`pty-agent-status-${paneId}`, callback),
    onError: (paneId: string, callback: (message: string) => void) =>
      onChannel(`pty-error-${paneId}`, callback),
  },

  layout: {
    save: (workspace: unknown) => ipcRenderer.invoke("layout:save", workspace),
    load: () => ipcRenderer.invoke("layout:load"),
    getRestoredSessions: () => ipcRenderer.invoke("layout:getRestoredSessions"),
  },

  projects: {
    getAll: () => ipcRenderer.invoke("projects:getAll"),
    getSelectedIndex: () => ipcRenderer.invoke("projects:getSelectedIndex"),
    select: (index: number) => ipcRenderer.invoke("projects:select", index),
    add: (name: string, path: string) =>
      ipcRenderer.invoke("projects:add", name, path),
    remove: (projectId: string) =>
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
    createWorktree: (projectId: string, name: string, branch?: string, linkedIssue?: { id: string; identifier: string; title: string; url: string }) =>
      ipcRenderer.invoke("projects:createWorktree", projectId, name, branch, linkedIssue),
    listRemoteBranches: (projectId: string) =>
      ipcRenderer.invoke("projects:listRemoteBranches", projectId),
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
    reorder: (orderedIds: string[]) =>
      ipcRenderer.invoke("projects:reorder", orderedIds),
    update: (
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
        color: string | null;
      }>,
    ) => ipcRenderer.invoke("projects:update", projectId, updates),
  },

  theme: {
    get: () => ipcRenderer.invoke("theme:get"),
    setSelected: (name: string) =>
      ipcRenderer.invoke("theme:setSelected", name),
    getSelectedName: () => ipcRenderer.invoke("theme:getSelectedName"),
    hasGhosttyConfig: () => ipcRenderer.invoke("theme:hasGhosttyConfig"),
    preview: (name: string) => ipcRenderer.invoke("theme:preview", name),
    allColors: () => ipcRenderer.invoke("theme:allColors"),
  },

  ports: {
    startScanner: () => ipcRenderer.invoke("ports:startScanner"),
    stopScanner: () => ipcRenderer.invoke("ports:stopScanner"),
    updateWorkspacePaths: (paths: string[]) =>
      ipcRenderer.invoke("ports:updateWorkspacePaths", paths),
    updateWorkspaceMetadata: (
      meta: Array<{
        path: string;
        projectName: string | null;
        branch: string | null;
        isMain: boolean;
      }>,
    ) => ipcRenderer.invoke("ports:updateWorkspaceMetadata", meta),
    killPort: (pid: number) => ipcRenderer.invoke("ports:killPort", pid),
    scanNow: () => ipcRenderer.invoke("ports:scanNow"),
    onChange: (callback: (ports: unknown[]) => void) =>
      onChannel("ports-changed", callback),
  },

  branches: {
    start: (paths: string[]) => ipcRenderer.invoke("branches:start", paths),
    stop: () => ipcRenderer.invoke("branches:stop"),
    onChange: (callback: (branches: Record<string, string>) => void) =>
      onChannel("branches-changed", callback),
  },

  diffs: {
    start: (workspaces: Record<string, string>) =>
      ipcRenderer.invoke("diffs:start", workspaces),
    stop: () => ipcRenderer.invoke("diffs:stop"),
    onChange: (
      callback: (
        diffs: Record<string, { added: number; removed: number }>,
      ) => void,
    ) => onChannel("diffs-changed", callback),
  },

  github: {
    getPrForBranch: (repoPath: string, branch: string) =>
      ipcRenderer.invoke("github:getPrForBranch", repoPath, branch),
    getPrsForBranches: (repoPath: string, branches: string[]) =>
      ipcRenderer.invoke("github:getPrsForBranches", repoPath, branches),
    checkStatus: () => ipcRenderer.invoke("github:checkStatus"),
    getMyIssues: (repoPath: string, limit?: number) =>
      ipcRenderer.invoke("github:getMyIssues", repoPath, limit),
    getAllIssues: (repoPath: string, limit?: number) =>
      ipcRenderer.invoke("github:getAllIssues", repoPath, limit),
    getIssueDetail: (repoPath: string, issueNumber: number) =>
      ipcRenderer.invoke("github:getIssueDetail", repoPath, issueNumber),
    assignIssue: (repoPath: string, issueNumber: number) =>
      ipcRenderer.invoke("github:assignIssue", repoPath, issueNumber),
  },

  linear: {
    connect: (apiKey: string) => ipcRenderer.invoke("linear:connect", apiKey),
    disconnect: () => ipcRenderer.invoke("linear:disconnect"),
    isConnected: () => ipcRenderer.invoke("linear:isConnected"),
    getViewer: () => ipcRenderer.invoke("linear:getViewer"),
    getTeams: () => ipcRenderer.invoke("linear:getTeams"),
    getMyIssues: (
      teamIds: string[],
      options?: { stateTypes?: string[]; limit?: number },
    ) => ipcRenderer.invoke("linear:getMyIssues", teamIds, options),
    getIssueDetail: (issueId: string) =>
      ipcRenderer.invoke("linear:getIssueDetail", issueId),
    getAllIssues: (
      teamIds: string[],
      options?: { stateTypes?: string[]; limit?: number },
    ) => ipcRenderer.invoke("linear:getAllIssues", teamIds, options),
    autoMatch: () => ipcRenderer.invoke("linear:autoMatch"),
    startIssue: (issueId: string) =>
      ipcRenderer.invoke("linear:startIssue", issueId),
    linkIssueToWorkspace: (
      projectId: string,
      workspacePath: string,
      issue: { id: string; identifier: string; title: string; url: string },
    ) =>
      ipcRenderer.invoke(
        "linear:linkIssueToWorkspace",
        projectId,
        workspacePath,
        issue,
      ),
    unlinkIssueFromWorkspace: (
      projectId: string,
      workspacePath: string,
      issueId: string,
    ) =>
      ipcRenderer.invoke(
        "linear:unlinkIssueFromWorkspace",
        projectId,
        workspacePath,
        issueId,
      ),
  },

  dialog: {
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  },

  shell: {
    openExternal: (url: string) =>
      ipcRenderer.invoke("shell:openExternal", url),
    openInEditor: (path: string) =>
      ipcRenderer.invoke("shell:openInEditor", path),
  },

  updater: {
    checkForUpdates: () => ipcRenderer.invoke("updater:checkForUpdates"),
    quitAndInstall: () => ipcRenderer.invoke("updater:quitAndInstall"),
    onUpdateAvailable: (callback: (info: { version: string }) => void) =>
      onChannel("updater:update-available", callback),
    onUpdateDownloaded: (callback: (info: { version: string }) => void) =>
      onChannel("updater:update-downloaded", callback),
    onDownloadProgress: (
      callback: (progress: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      }) => void,
    ) => onChannel("updater:download-progress", callback),
    onError: (callback: (message: string) => void) =>
      onChannel("updater:error", callback),
  },

  tasks: {
    getAll: (opts?: {
      projectId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke("tasks:getAll", opts),
    get: (taskId: string) => ipcRenderer.invoke("tasks:get", taskId),
    update: (taskId: string, updates: object) =>
      ipcRenderer.invoke("tasks:update", taskId, updates),
    delete: (taskId: string) => ipcRenderer.invoke("tasks:delete", taskId),
    setPaneContext: (
      paneId: string,
      context: {
        projectId: string;
        projectName: string;
        workspacePath: string;
      },
    ) => ipcRenderer.invoke("tasks:setPaneContext", paneId, context),
    markSeen: (taskId: string) => ipcRenderer.invoke("tasks:markSeen", taskId),
    onUpdate: (callback: (task: unknown) => void) =>
      onChannel("task-updated", callback),
  },

  preferences: {
    getAll: () => ipcRenderer.invoke("preferences:getAll"),
    set: (key: string, value: unknown) =>
      ipcRenderer.invoke("preferences:set", key, value),
    onChange: (callback: (prefs: unknown) => void) =>
      onChannel("preferences-changed", callback),
    playSound: (name: string) =>
      ipcRenderer.invoke("preferences:playSound", name),
  },

  keybindings: {
    getAll: () => ipcRenderer.invoke("keybindings:getAll"),
    set: (commandId: string, combo: string) =>
      ipcRenderer.invoke("keybindings:set", commandId, combo),
    reset: (commandId: string) =>
      ipcRenderer.invoke("keybindings:reset", commandId),
    resetAll: () => ipcRenderer.invoke("keybindings:resetAll"),
    onChange: (callback: (overrides: Record<string, string>) => void) =>
      onChannel("keybindings-changed", callback),
  },

  notifications: {
    onNavigateToTask: (callback: (taskId: string) => void) =>
      onChannel("notification:navigate-to-task", callback),
  },

  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke("clipboard:writeText", text),
  },

  webview: {
    register: (paneId: string, webContentsId: number) =>
      ipcRenderer.invoke("webview:register", paneId, webContentsId),
    unregister: (paneId: string) =>
      ipcRenderer.invoke("webview:unregister", paneId),
    startPicker: (paneId: string) =>
      ipcRenderer.invoke("webview:start-picker", paneId),
    cancelPicker: (paneId: string) =>
      ipcRenderer.invoke("webview:cancel-picker", paneId),
    onPickerResult: (
      callback: (paneId: string, result: unknown) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        paneId: string,
        result: unknown,
      ) => callback(paneId, result);
      ipcRenderer.on("webview:picker-result", listener);
      return () =>
        ipcRenderer.removeListener("webview:picker-result", listener);
    },
    onPickerCancel: (callback: (paneId: string) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        paneId: string,
      ) => callback(paneId);
      ipcRenderer.on("webview:picker-cancel", listener);
      return () =>
        ipcRenderer.removeListener("webview:picker-cancel", listener);
    },
    onEscape: (callback: (paneId: string) => void) =>
      onChannel('webview:escape', callback),
  },
});
