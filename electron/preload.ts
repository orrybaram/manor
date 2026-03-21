import { contextBridge, ipcRenderer } from "electron";

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
    onOutput: (paneId: string, callback: (data: string) => void) => {
      const channel = `pty-output-${paneId}`;
      const listener = (_event: Electron.IpcRendererEvent, data: string) =>
        callback(data);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
    onExit: (paneId: string, callback: () => void) => {
      const channel = `pty-exit-${paneId}`;
      const listener = () => callback();
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
    onCwd: (paneId: string, callback: (cwd: string) => void) => {
      const channel = `pty-cwd-${paneId}`;
      const listener = (_event: Electron.IpcRendererEvent, cwd: string) =>
        callback(cwd);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
    onAgentStatus: (paneId: string, callback: (agent: unknown) => void) => {
      const channel = `pty-agent-status-${paneId}`;
      const listener = (_event: Electron.IpcRendererEvent, agent: unknown) =>
        callback(agent);
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  },

  layout: {
    save: (workspace: unknown) =>
      ipcRenderer.invoke("layout:save", workspace),
    load: () => ipcRenderer.invoke("layout:load"),
    getRestoredSessions: () => ipcRenderer.invoke("layout:getRestoredSessions"),
  },

  projects: {
    getAll: () => ipcRenderer.invoke("projects:getAll"),
    getSelectedIndex: () =>
      ipcRenderer.invoke("projects:getSelectedIndex"),
    select: (index: number) =>
      ipcRenderer.invoke("projects:select", index),
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
    scanNow: () => ipcRenderer.invoke("ports:scanNow"),
    onChange: (callback: (ports: unknown[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ports: unknown[]) =>
        callback(ports);
      ipcRenderer.on("ports-changed", listener);
      return () => {
        ipcRenderer.removeListener("ports-changed", listener);
      };
    },
  },

  branches: {
    start: (paths: string[]) =>
      ipcRenderer.invoke("branches:start", paths),
    stop: () => ipcRenderer.invoke("branches:stop"),
    onChange: (callback: (branches: Record<string, string>) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        branches: Record<string, string>,
      ) => callback(branches);
      ipcRenderer.on("branches-changed", listener);
      return () => {
        ipcRenderer.removeListener("branches-changed", listener);
      };
    },
  },

  diffs: {
    start: (workspaces: Record<string, string>) =>
      ipcRenderer.invoke("diffs:start", workspaces),
    stop: () => ipcRenderer.invoke("diffs:stop"),
    onChange: (
      callback: (diffs: Record<string, { added: number; removed: number }>) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        diffs: Record<string, { added: number; removed: number }>,
      ) => callback(diffs);
      ipcRenderer.on("diffs-changed", listener);
      return () => {
        ipcRenderer.removeListener("diffs-changed", listener);
      };
    },
  },

  github: {
    getPrForBranch: (repoPath: string, branch: string) =>
      ipcRenderer.invoke("github:getPrForBranch", repoPath, branch),
    getPrsForBranches: (repoPath: string, branches: string[]) =>
      ipcRenderer.invoke("github:getPrsForBranches", repoPath, branches),
  },

  linear: {
    connect: (apiKey: string) =>
      ipcRenderer.invoke("linear:connect", apiKey),
    disconnect: () => ipcRenderer.invoke("linear:disconnect"),
    isConnected: () => ipcRenderer.invoke("linear:isConnected"),
    getViewer: () => ipcRenderer.invoke("linear:getViewer"),
    getTeams: () => ipcRenderer.invoke("linear:getTeams"),
    getMyIssues: (
      teamIds: string[],
      options?: { stateTypes?: string[]; limit?: number },
    ) => ipcRenderer.invoke("linear:getMyIssues", teamIds, options),
    autoMatch: () => ipcRenderer.invoke("linear:autoMatch"),
  },

  dialog: {
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  },

  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  },
});
