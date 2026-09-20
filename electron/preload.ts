import { contextBridge, ipcRenderer } from "electron";
import type { AppCommand, AppCommandResult } from "./renderer-bridge";
import type {
  ForwardedCommandPayload,
  MenuCommandPayload,
  MenuContext,
} from "../src/lib/menu-commands";

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Payload of the main→renderer "webview:recording-command" channel (ADR-158).
 * Mirrors `RecordingCommand` in `src/lib/webview-recorder.ts`; declared here
 * rather than imported so the preload's type surface stays self-contained.
 */
interface WebviewRecordingCommand {
  cmd: "start" | "stop";
  recordingId: string;
  mediaSourceId?: string;
  paneId: string;
}

export type PushProgressEvent =
  | { pushId: string; type: "line"; line: string }
  | { pushId: string; type: "done"; exitCode: number | null; stderr: string };

function onChannel<T>(
  channel: string,
  callback: (value: T) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Synchronously read isPackaged from the CLI argument injected by main via additionalArguments
const isPackaged = process.argv.includes("--manor-packaged=true");

// Detached-window flag (ADR-156, ADR-179 D4). Mirrors the `--manor-packaged`
// pattern: main injects `--manor-detached=<windowId>` via additionalArguments
// so the renderer knows synchronously, without an IPC round-trip.
const detachedArg = process.argv.find((arg) =>
  arg.startsWith("--manor-detached="),
);
const detachedWindowId = detachedArg
  ? detachedArg.slice("--manor-detached=".length)
  : null;
const isDetached = detachedWindowId !== null;

// The tab this window holds (ADR-179 D4), as `--manor-claim=<tabId>::<path>`.
// Split on the FIRST separator: a tab id is `tab-<uuid>` and cannot contain
// one, a workspace path can contain anything. Read here for the same reason
// `isDetached` is — the store needs it before it loads anything.
const claimArg = process.argv.find((arg) => arg.startsWith("--manor-claim="));
const claim = (() => {
  if (!claimArg) return null;
  const raw = claimArg.slice("--manor-claim=".length);
  const at = raw.indexOf("::");
  if (at <= 0) return null;
  const tabId = raw.slice(0, at);
  const workspacePath = raw.slice(at + 2);
  if (!workspacePath) return null;
  return { workspacePath, tabId };
})();

// Who this renderer is, as the Manor server names it in a layout command's
// origin (ADR-179 D3): `webContents.id`, which main knows and a page cannot
// be told through `additionalArguments` — the id does not exist until the
// window that owns this preload does. Synchronous for the same reason
// `isPackaged` is: the store reads it while handling a broadcast.
let rendererId: string | null = null;
try {
  rendererId = String(ipcRenderer.sendSync("viewport:rendererId"));
} catch {
  // No handler yet (a window opened before `registerIpcHandlers`): a null id
  // matches no origin, so selection hints are simply not applied.
}

/**
 * Everything the preload still answers itself (ADR-180 D3).
 *
 * This object used to *be* `window.electronAPI`, exposed straight to the page
 * — 211 methods in 26 namespaces, every one of them written twice, once here
 * and once as a bridge handler table entry. It is now handed to the page as
 * `manorHost.native` and the page builds `electronAPI` over it
 * (`src/bridge/client.ts`), because a `Proxy` cannot cross `contextBridge`:
 * the bridge copies the shape it is handed, and a proxy's members are not
 * there to copy.
 *
 * Nothing has left yet, so every call still lands here and the desktop
 * behaves exactly as it did. The later ADR-180 tickets take a group out at a
 * time; what remains at the end is the set that can never leave — `webview`,
 * `window`, `menu`, `dialog`, `shell`, `clipboard`, `updater` — plus the
 * root-level functions below, which the client serves the same way.
 *
 * The synchronous facts (`platform`, `rendererId`, `isDetached`,
 * `detachedWindowId`, `claim`, `env`) are *not* here: they are read off argv
 * and live on `manorHost` itself, which is the only place the page needs them
 * and the only place that can answer them before the first invoke.
 */
const nativeApi = {
  pty: {
    create: (
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
      agentKind?: string | null,
    ) => ipcRenderer.invoke("pty:create", paneId, cwd, cols, rows, agentKind),
    write: (paneId: string, data: string) =>
      ipcRenderer.invoke("pty:write", paneId, data),
    resize: (paneId: string, cols: number, rows: number) =>
      ipcRenderer.invoke("pty:resize", paneId, cols, rows),
    close: (paneId: string) => ipcRenderer.invoke("pty:close", paneId),
    reset: (paneId: string, cwd: string | null, cols: number, rows: number) =>
      ipcRenderer.invoke("pty:reset", paneId, cwd, cols, rows),
    detach: (paneId: string) => ipcRenderer.invoke("pty:detach", paneId),
    consumePrewarmed: () => ipcRenderer.invoke("pty:consumePrewarmed"),
    updatePrewarmCwd: (
      cwd: string,
      agentCommand?: string | null,
      agentKind?: string | null,
    ) =>
      ipcRenderer.invoke("pty:updatePrewarmCwd", cwd, agentCommand, agentKind),
    // Output carries its position in the session's stream (ADR-159) so the
    // renderer can drop what a warm-restore snapshot already covers. It is
    // undefined when an older daemon is on the other end.
    onOutput: (
      paneId: string,
      callback: (data: string, seq?: number) => void,
    ) => {
      const channel = `pty-output-${paneId}`;
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: string,
        seq?: number,
      ) => callback(data, seq);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onExit: (paneId: string, callback: () => void) =>
      onChannel(`pty-exit-${paneId}`, callback),
    onCwd: (paneId: string, callback: (cwd: string) => void) =>
      onChannel(`pty-cwd-${paneId}`, callback),
    onAgentStatus: (paneId: string, callback: (agent: unknown) => void) =>
      onChannel(`pty-agent-status-${paneId}`, callback),
    onError: (paneId: string, callback: (message: string) => void) =>
      onChannel(`pty-error-${paneId}`, callback),
    // Its own listener rather than `onChannel`, which forwards a single value:
    // through that helper `rows` arrived as undefined and xterm rejected the
    // resize from inside a write callback, wedging the terminal for good.
    onResized: (
      paneId: string,
      callback: (cols: number, rows: number) => void,
    ) => {
      const channel = `pty-resized-${paneId}`;
      const listener = (
        _event: Electron.IpcRendererEvent,
        cols: number,
        rows: number,
      ) => callback(cols, rows);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    /**
     * Live winsize-ownership changes (ADR-179 D6), for a viewer whose owner
     * moved without a `pty.create`/`pty.reset` reply of its own to read it
     * from — a bridge viewer that just got outbid by another, or one whose
     * owner disconnected. A no-op here: the desktop's own attach always wins
     * ownership the moment it exists (D5), so it never needs telling it lost
     * something, and nothing publishes on this channel for it to hear.
     */
    onWinsizeOwner: (
      _paneId: string,
      _callback: (payload: {
        paneId: string;
        cols: number;
        rows: number;
        owner: boolean;
      }) => void,
    ) => () => {},
  },

  layout: {
    // ADR-179 D1: the server owns the layout. A renderer reads it with
    // `getAll`, changes it with `apply`, and hears every change — its own
    // included — on `onChanged`. There is no `save`.
    getAll: () => ipcRenderer.invoke("layout:getAll"),
    getLastActive: () => ipcRenderer.invoke("layout:getLastActive"),
    apply: (workspacePath: string, command: unknown) =>
      ipcRenderer.invoke("layout:apply", workspacePath, command),
    setPendingCommand: (paneId: string, text: string, kind?: string) =>
      ipcRenderer.invoke("layout:setPendingCommand", paneId, text, kind),
    remove: (workspacePath: string) =>
      ipcRenderer.invoke("layout:remove", workspacePath),
    reportViewport: (
      workspacePath: string,
      rendererId: string,
      viewport: unknown,
    ) =>
      ipcRenderer.invoke(
        "layout:reportViewport",
        workspacePath,
        rendererId,
        viewport,
      ),
    onChanged: (callback: (payload: unknown) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: unknown,
      ) => callback(payload);
      ipcRenderer.on("layout:changed", listener);
      return () => ipcRenderer.removeListener("layout:changed", listener);
    },
  },

  // This renderer's own viewport file (ADR-179 D3) — never the bridge's.
  viewport: {
    load: () => ipcRenderer.invoke("viewport:load"),
    save: (file: unknown) => ipcRenderer.invoke("viewport:save", file),
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
    onRemoveWorktreeProgress: (callback: (step: string) => void) =>
      onChannel<string>("projects:removeWorktree:progress", callback),
    onWorktreeSetupProgress: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on("worktree:setup-progress", handler);
      return () =>
        ipcRenderer.removeListener("worktree:setup-progress", handler);
    },
    canQuickMerge: (projectId: string, worktreePath: string) =>
      ipcRenderer.invoke("projects:canQuickMerge", projectId, worktreePath),
    quickMergeWorktree: (projectId: string, worktreePath: string) =>
      ipcRenderer.invoke(
        "projects:quickMergeWorktree",
        projectId,
        worktreePath,
      ),
    createWorktree: (
      projectId: string,
      name: string,
      branch?: string,
      linkedIssue?: {
        id: string;
        identifier: string;
        title: string;
        url: string;
      },
      baseBranch?: string,
      useExistingBranch?: boolean,
    ) =>
      ipcRenderer.invoke(
        "projects:createWorktree",
        projectId,
        name,
        branch,
        linkedIssue,
        baseBranch,
        useExistingBranch,
      ),
    convertMainToWorktree: (projectId: string, name: string) =>
      ipcRenderer.invoke("projects:convertMainToWorktree", projectId, name),
    listRemoteBranches: (projectId: string) =>
      ipcRenderer.invoke("projects:listRemoteBranches", projectId),
    listLocalBranches: (projectId: string) =>
      ipcRenderer.invoke("projects:listLocalBranches", projectId),
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
    setWorkspaceHidden: (
      projectId: string,
      workspacePath: string,
      hidden: boolean,
    ) =>
      ipcRenderer.invoke(
        "projects:setWorkspaceHidden",
        projectId,
        workspacePath,
        hidden,
      ),
    createWorkspaceFolder: (
      projectId: string,
      name: string,
      parentId?: string | null,
    ) =>
      ipcRenderer.invoke(
        "projects:createWorkspaceFolder",
        projectId,
        name,
        parentId ?? null,
      ),
    // Resolves false when the move would create a folder cycle (ADR-172).
    setFolderParent: (
      projectId: string,
      folderId: string,
      parentId: string | null,
    ) =>
      ipcRenderer.invoke(
        "projects:setFolderParent",
        projectId,
        folderId,
        parentId,
      ),
    renameWorkspaceFolder: (
      projectId: string,
      folderId: string,
      name: string,
    ) =>
      ipcRenderer.invoke(
        "projects:renameWorkspaceFolder",
        projectId,
        folderId,
        name,
      ),
    deleteWorkspaceFolder: (projectId: string, folderId: string) =>
      ipcRenderer.invoke("projects:deleteWorkspaceFolder", projectId, folderId),
    setWorkspaceFolder: (
      projectId: string,
      workspacePath: string,
      folderId: string | null,
    ) =>
      ipcRenderer.invoke(
        "projects:setWorkspaceFolder",
        projectId,
        workspacePath,
        folderId,
      ),
    // orderedKeys entries may be workspace paths or folder ids (ADR-167).
    reorderWorkspaces: (projectId: string, orderedKeys: string[]) =>
      ipcRenderer.invoke("projects:reorderWorkspaces", projectId, orderedKeys),
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
    /**
     * The selected theme changed — in this window, another desktop window, or
     * a browser on the bridge (ADR-179 ticket 7). The payload is the same
     * `{ name, theme }` shape `setSelected` itself resolves with, so a
     * listener can apply it directly instead of a round trip back to
     * `theme:get`.
     */
    onChanged: (
      callback: (payload: { name: string; theme: unknown }) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { name: string; theme: unknown },
      ) => callback(payload);
      ipcRenderer.on("theme:changed", listener);
      return () => ipcRenderer.removeListener("theme:changed", listener);
    },
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
        portlessEnabled: boolean;
      }>,
    ) => ipcRenderer.invoke("ports:updateWorkspaceMetadata", meta),
    killPort: (pid: number) => ipcRenderer.invoke("ports:killPort", pid),
    scanNow: () => ipcRenderer.invoke("ports:scanNow"),
    onChange: (callback: (ports: unknown[]) => void) =>
      onChannel("ports-changed", callback),
  },

  processes: {
    list: () => ipcRenderer.invoke("processes:list"),
    killSession: (sessionId: string) =>
      ipcRenderer.invoke("processes:killSession", sessionId),
    cleanupDead: () => ipcRenderer.invoke("processes:cleanupDead"),
    killDaemon: () => ipcRenderer.invoke("processes:killDaemon"),
    killAll: () => ipcRenderer.invoke("processes:killAll"),
    restartPortless: () => ipcRenderer.invoke("processes:restartPortless"),
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
    getFullDiff: (wsPath: string, defaultBranch: string) =>
      ipcRenderer.invoke("diffs:getFullDiff", wsPath, defaultBranch),
    getLocalDiff: (wsPath: string) =>
      ipcRenderer.invoke("diffs:getLocalDiff", wsPath),
    getStagedFiles: (wsPath: string) =>
      ipcRenderer.invoke("diffs:getStagedFiles", wsPath) as Promise<string[]>,
  },

  git: {
    stage: (wsPath: string, files: string[]) =>
      ipcRenderer.invoke("git:stage", wsPath, files),
    unstage: (wsPath: string, files: string[]) =>
      ipcRenderer.invoke("git:unstage", wsPath, files),
    discard: (wsPath: string, files: string[]) =>
      ipcRenderer.invoke("git:discard", wsPath, files),
    stash: (wsPath: string, files: string[]) =>
      ipcRenderer.invoke("git:stash", wsPath, files),
    commit: (wsPath: string, message: string, flags: string[]) =>
      ipcRenderer.invoke("git:commit", wsPath, message, flags),
    push: {
      start: (args: { wsPath: string; setUpstream?: boolean }) =>
        ipcRenderer.invoke("git:push:start", args),
      cancel: (pushId: string) =>
        ipcRenderer.invoke("git:push:cancel", { pushId }),
      onProgress: (handler: (evt: PushProgressEvent) => void) => {
        const listener = (_e: unknown, evt: PushProgressEvent) => handler(evt);
        ipcRenderer.on("git:push:progress", listener);
        return () => ipcRenderer.removeListener("git:push:progress", listener);
      },
    },
  },

  github: {
    getPrForBranch: (repoPath: string, branch: string) =>
      ipcRenderer.invoke("github:getPrForBranch", repoPath, branch),
    getPrsForBranches: (repoPath: string, branches: string[]) =>
      ipcRenderer.invoke("github:getPrsForBranches", repoPath, branches),
    checkStatus: () => ipcRenderer.invoke("github:checkStatus"),
    getMyIssues: (
      repoPath: string,
      limit?: number,
      state?: "open" | "closed" | "all",
    ) => ipcRenderer.invoke("github:getMyIssues", repoPath, limit, state),
    getAllIssues: (
      repoPath: string,
      limit?: number,
      state?: "open" | "closed" | "all",
    ) => ipcRenderer.invoke("github:getAllIssues", repoPath, limit, state),
    getIssueDetail: (repoPath: string, issueNumber: number) =>
      ipcRenderer.invoke("github:getIssueDetail", repoPath, issueNumber),
    assignIssue: (repoPath: string, issueNumber: number) =>
      ipcRenderer.invoke("github:assignIssue", repoPath, issueNumber),
    closeIssue: (repoPath: string, issueNumber: number) =>
      ipcRenderer.invoke("github:closeIssue", repoPath, issueNumber),
    createIssue: (title: string, body: string, labels: string[]) =>
      ipcRenderer.invoke("github:createIssue", title, body, labels),
    uploadFeedbackImages: (images: { base64: string; name: string }[]) =>
      ipcRenderer.invoke("github:uploadFeedbackImages", images),
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
    proxyImage: (url: string) => ipcRenderer.invoke("linear:proxyImage", url),
    autoMatch: () => ipcRenderer.invoke("linear:autoMatch"),
    startIssue: (issueId: string) =>
      ipcRenderer.invoke("linear:startIssue", issueId),
    closeIssue: (issueId: string) =>
      ipcRenderer.invoke("linear:closeIssue", issueId),
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
    resolveFilePath: (filePath: string, cwd: string) =>
      ipcRenderer.invoke("shell:resolveFilePath", filePath, cwd) as Promise<
        string | null
      >,
    discoverAgents: () =>
      ipcRenderer.invoke("shell:discoverAgents") as Promise<
        Array<{ name: string; command: string }>
      >,
    showItemInFolder: (path: string) =>
      ipcRenderer.invoke("shell:showItemInFolder", path) as Promise<void>,
  },

  updater: {
    checkForUpdates: () => ipcRenderer.invoke("updater:checkForUpdates"),
    quitAndInstall: () => ipcRenderer.invoke("updater:quitAndInstall"),
    onChecking: (callback: (payload: { manual: boolean }) => void) =>
      onChannel("updater:checking-for-update", callback),
    onUpdateAvailable: (callback: (info: { version: string }) => void) =>
      onChannel("updater:update-available", callback),
    onUpdateDownloaded: (callback: (info: { version: string }) => void) =>
      onChannel("updater:update-downloaded", callback),
    onUpdateNotAvailable: (
      callback: (info: { version: string; manual: boolean }) => void,
    ) => onChannel("updater:update-not-available", callback),
    onDownloadProgress: (
      callback: (progress: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      }) => void,
    ) => onChannel("updater:download-progress", callback),
    onError: (
      callback: (payload: { message: string; manual: boolean }) => void,
    ) => onChannel("updater:error", callback),
  },

  agents: {
    getAll: (opts?: {
      projectId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke("agents:getAll", opts),
    getActive: () => ipcRenderer.invoke("agents:getActive"),
    getRecent: (opts?: { limit?: number }) =>
      ipcRenderer.invoke("agents:getRecent", opts),
    getUnseen: () => ipcRenderer.invoke("agents:getUnseen"),
    consumePruneNotice: () => ipcRenderer.invoke("agents:consumePruneNotice"),
    get: (agentId: string) => ipcRenderer.invoke("agents:get", agentId),
    update: (
      agentId: string,
      updates: { name?: string | null; namePinned?: boolean },
    ) => ipcRenderer.invoke("agents:update", agentId, updates),
    delete: (agentId: string) => ipcRenderer.invoke("agents:delete", agentId),
    setPaneContext: (
      paneId: string,
      context: {
        projectId: string;
        projectName: string;
        workspacePath: string;
        agentCommand: string | null;
      },
    ) => ipcRenderer.invoke("agents:setPaneContext", paneId, context),
    markSeen: (agentId: string) =>
      ipcRenderer.invoke("agents:markSeen", agentId),
    markResumed: (agentId: string) =>
      ipcRenderer.invoke("agents:markResumed", agentId),
    buildResumeCommand: (agentId: string) =>
      ipcRenderer.invoke("agents:buildResumeCommand", agentId),
    reconcileStale: () => ipcRenderer.invoke("agents:reconcileStale"),
    abandonForPane: (paneId: string, title?: string | null) =>
      ipcRenderer.invoke("agents:abandonForPane", paneId, title),
    onUpdate: (
      callback: (
        agent: unknown,
        unseen: { responded: boolean; requires_input: boolean },
      ) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        agent: unknown,
        unseen: { responded: boolean; requires_input: boolean },
      ) => callback(agent, unseen);
      ipcRenderer.on("agent-updated", listener);
      return () => ipcRenderer.removeListener("agent-updated", listener);
    },
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
    /**
     * A bound combo pressed where this window's key handler can't see it — in
     * a web page, or a primary-only command pressed in a popout.
     */
    onForwardedCommand: (
      callback: (payload: ForwardedCommandPayload) => void,
    ) => onChannel("keybinding-command", callback),
    /** Popout → main: focus the primary window and run `commandId` there. */
    runInMainWindow: (commandId: string) =>
      ipcRenderer.send("keybindings:runInMainWindow", commandId),
  },

  menu: {
    /** Pushes a fresh `MenuContext` snapshot so main can label/enable menu items. */
    setContext: (context: MenuContext) =>
      ipcRenderer.send("menu:setContext", context),
    /** A native menu item was clicked; fire-and-forget, like a keybinding. */
    onMenuCommand: (callback: (payload: MenuCommandPayload) => void) =>
      onChannel("menu-command", callback),
  },

  notifications: {
    show: (payload: {
      kind: "comment" | "approved" | "changes-requested" | "checks-failed";
      title: string;
      body: string;
      url?: string;
      comment?: {
        author: string;
        body: string;
        url: string;
        createdAt: string;
      };
    }) => ipcRenderer.invoke("notifications:show", payload) as Promise<boolean>,
    getAll: () => ipcRenderer.invoke("notifications:getAll"),
    markRead: (id: string) => ipcRenderer.invoke("notifications:markRead", id),
    markAllRead: () => ipcRenderer.invoke("notifications:markAllRead"),
    clear: () => ipcRenderer.invoke("notifications:clear"),
    /** Main re-broadcasts the whole list on every mutation (ADR-162 §3). */
    onChanged: (callback: (list: unknown[]) => void) =>
      onChannel("notifications:changed", callback),
    /** A native banner was clicked; the payload is the record id. */
    onNavigate: (callback: (id: string) => void) =>
      onChannel("notifications:navigate", callback),
  },

  stats: {
    getSummary: () => ipcRenderer.invoke("stats:getSummary"),
    reset: () => ipcRenderer.invoke("stats:reset"),
    /** Main re-broadcasts the full summary after every settled burst (ADR-168 §5). */
    onChanged: (callback: (summary: unknown) => void) =>
      onChannel("stats:changed", callback),
  },

  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke("clipboard:writeText", text),
  },

  /** Main mutated the project list out-of-band (MCP, CLI) — refetch it. */
  onProjectsChanged: (callback: () => void) =>
    onChannel("projects-changed", callback),

  onAppCommand: (callback: (payload: AppCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AppCommand) =>
      callback(payload);
    ipcRenderer.on("app-command", listener);
    return () => ipcRenderer.removeListener("app-command", listener);
  },

  /**
   * Answer an "app-command" that carried a `requestId`. Commands without one
   * are fire-and-forget and must not be answered — main has no pending entry
   * for them and will drop the reply.
   */
  sendAppCommandResult: (result: AppCommandResult) =>
    ipcRenderer.send("app-command-result", result),

  webview: {
    register: (paneId: string, webContentsId: number) =>
      ipcRenderer.invoke("webview:register", paneId, webContentsId),
    unregister: (paneId: string) =>
      ipcRenderer.invoke("webview:unregister", paneId),
    startPicker: (paneId: string) =>
      ipcRenderer.invoke("webview:start-picker", paneId),
    cancelPicker: (paneId: string) =>
      ipcRenderer.invoke("webview:cancel-picker", paneId),
    zoomIn: (paneId: string) => ipcRenderer.invoke("webview:zoom-in", paneId),
    zoomOut: (paneId: string) => ipcRenderer.invoke("webview:zoom-out", paneId),
    zoomReset: (paneId: string) =>
      ipcRenderer.invoke("webview:zoom-reset", paneId),
    onPickerResult: (callback: (paneId: string, result: unknown) => void) => {
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
      const listener = (_event: Electron.IpcRendererEvent, paneId: string) =>
        callback(paneId);
      ipcRenderer.on("webview:picker-cancel", listener);
      return () =>
        ipcRenderer.removeListener("webview:picker-cancel", listener);
    },
    onEscape: (callback: (paneId: string) => void) =>
      onChannel("webview:escape", callback),
    onFocusUrl: (callback: (paneId: string) => void) =>
      onChannel("webview:focus-url", callback),
    onNewWindow: (
      callback: (
        paneId: string,
        url: string,
        opts?: { background?: boolean },
      ) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        paneId: string,
        url: string,
        opts?: { background?: boolean },
      ) => callback(paneId, url, opts);
      ipcRenderer.on("webview:new-window", listener);
      return () => ipcRenderer.removeListener("webview:new-window", listener);
    },
    stop: (paneId: string) => ipcRenderer.invoke("webview:stop", paneId),
    findInPage: (
      paneId: string,
      query: string,
      options?: { forward?: boolean; findNext?: boolean },
    ) => ipcRenderer.invoke("webview:find-in-page", paneId, query, options),
    stopFindInPage: (paneId: string) =>
      ipcRenderer.invoke("webview:stop-find-in-page", paneId),
    onLoadingChanged: (
      callback: (paneId: string, isLoading: boolean) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        paneId: string,
        isLoading: boolean,
      ) => callback(paneId, isLoading);
      ipcRenderer.on("webview:loading-changed", listener);
      return () =>
        ipcRenderer.removeListener("webview:loading-changed", listener);
    },
    onFaviconUpdated: (
      callback: (paneId: string, faviconUrl: string) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        paneId: string,
        faviconUrl: string,
      ) => callback(paneId, faviconUrl);
      ipcRenderer.on("webview:favicon-updated", listener);
      return () =>
        ipcRenderer.removeListener("webview:favicon-updated", listener);
    },
    onFindResult: (
      callback: (
        paneId: string,
        result: {
          activeMatchOrdinal: number;
          matches: number;
          finalUpdate: boolean;
        },
      ) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        paneId: string,
        result: {
          activeMatchOrdinal: number;
          matches: number;
          finalUpdate: boolean;
        },
      ) => callback(paneId, result);
      ipcRenderer.on("webview:find-result", listener);
      return () => ipcRenderer.removeListener("webview:find-result", listener);
    },
    onFind: (callback: (paneId: string) => void) =>
      onChannel("webview:find", callback),
    onGoBack: (callback: (paneId: string) => void) =>
      onChannel("webview:go-back", callback),
    onGoForward: (callback: (paneId: string) => void) =>
      onChannel("webview:go-forward", callback),
    setAudioMuted: (paneId: string, muted: boolean) =>
      ipcRenderer.invoke("webview:set-audio-muted", paneId, muted),
    /**
     * One webm chunk from a pane's `MediaRecorder` (ADR-158). `send`, not
     * `invoke`: chunks arrive once a second per recording and main has nothing
     * useful to answer.
     */
    sendRecordingChunk: (recordingId: string, chunk: ArrayBuffer) =>
      ipcRenderer.send("webview:recording-chunk", recordingId, chunk),
    /** Renderer's recorder has flushed; main may finalize the file. */
    notifyRecordingStopped: (recordingId: string, error?: string) =>
      ipcRenderer.invoke("webview:recording-stopped", recordingId, error),
    /** Main-initiated start/stop of a pane recording. */
    onRecordingCommand: (
      callback: (command: WebviewRecordingCommand) => void,
    ) => onChannel("webview:recording-command", callback),
    /** User clicked the pane's "Recording" indicator to stop it (ADR-158). */
    stopRecording: (paneId: string) =>
      ipcRenderer.invoke("webview:stop-recording", paneId) as Promise<void>,
    onAudioStateChanged: (
      callback: (paneId: string, audible: boolean) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        paneId: string,
        audible: boolean,
      ) => callback(paneId, audible);
      ipcRenderer.on("webview:audio-state-changed", listener);
      return () =>
        ipcRenderer.removeListener("webview:audio-state-changed", listener);
    },
  },

  // Remote control (ADR-161). Off until the user enables it; `pair` is the one
  // call that returns a raw token, and it is returned once and never re-fetched.
  remoteControl: {
    getStatus: () => ipcRenderer.invoke("remoteControl:getStatus"),
    refreshDetection: () =>
      ipcRenderer.invoke("remoteControl:refreshDetection"),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("remoteControl:setEnabled", enabled),
    pair: (label: string, capability: "read" | "send" | "full") =>
      ipcRenderer.invoke("remoteControl:pair", label, capability),
    revoke: (id: string) => ipcRenderer.invoke("remoteControl:revoke", id),
    startTunnel: (kind?: "tailscale" | "cloudflared") =>
      ipcRenderer.invoke("remoteControl:startTunnel", kind),
    stopTunnel: () => ipcRenderer.invoke("remoteControl:stopTunnel"),
    onStatus: (callback: (status: unknown) => void) =>
      onChannel<unknown>("remoteControl:status", callback),
  },

  // Multi-window (ADR-156, ADR-179 D4). Named `window` on electronAPI — this
  // does NOT shadow the global `window`, which is untouched here.
  window: {
    detachTab: (
      workspacePath: string,
      tabId: string,
      spawnBounds?: WindowBounds,
    ) =>
      ipcRenderer.invoke(
        "window:detachTab",
        workspacePath,
        tabId,
        spawnBounds,
      ) as Promise<string>,
    getBounds: () =>
      ipcRenderer.invoke("window:getBounds") as Promise<WindowBounds>,
    setPosition: (x: number, y: number) =>
      ipcRenderer.send("window:setPosition", x, y),
    listWindows: () =>
      ipcRenderer.invoke("window:listWindows") as Promise<
        { id: number; bounds: WindowBounds }[]
      >,
    closeSelf: () => ipcRenderer.send("window:closeSelf"),
  },
};

/**
 * `window.manorHost` — the one concrete object the page builds a host client
 * over (ADR-180 D3).
 *
 * `electronAPI` above is 200-odd methods, each one an `ipcRenderer.invoke` or
 * an `ipcRenderer.on` written out by hand, and every host feature has had to
 * be written twice: once here, once as a bridge handler table entry. D1 makes
 * the table the one host surface and D2 gives it a second transport; what is
 * left for the preload is to hand the page a door onto that transport. The
 * page builds the `ns.method(...)` proxy over it (`src/bridge/client.ts`),
 * exactly as the web renderer already builds one over a WebSocket — which it
 * must, because `contextBridge` copies the shape it is handed and a `Proxy`'s
 * members are not there to copy.
 *
 * This is now the *only* thing the preload exposes. `electronAPI` is built in
 * the page over it and `native` above is what is left of the preload's own
 * methods — every namespace, for now, so every call still lands where it
 * always did. Later tickets hollow `native` out group by group, and each
 * group that leaves starts going over `invoke` on its very next call.
 *
 * The facts on it are the ones a renderer needs *synchronously*, before it
 * can invoke anything — they are read off argv above for that reason, and are
 * the same values `electronAPI` reports.
 *
 * The four channel names are written out rather than imported from
 * `electron/bridge/transports/ipc.ts`, which exports them as constants: that
 * module reaches for `ipcMain` and, through the handler table, the whole main
 * process. Importing it here would drag all of it into the renderer's bundle
 * to save four strings.
 */

/** Delivered a frame's `args`, spread — the same shape a preload `onX` has. */
type BridgeListener = (...args: unknown[]) => void;

/** One `bridge:event` from `electron/bridge/transports/ipc.ts`. */
interface BridgeEventFrame {
  ns: string;
  event: string;
  key?: string;
  args?: unknown[];
}

/**
 * The key a subscription that named none is filed under, here and in
 * `BridgeServer`. Kept off the wire: the host defaults a missing key to
 * exactly this, and sending it would be saying the same thing twice.
 */
const BRIDGE_ALL_KEYS = "*";

/**
 * `ns.event` → key → its listeners, duplicates and all.
 *
 * An array rather than a `Set` because this is a reference count and a `Set`
 * would collapse two subscriptions that happen to share a callback into one:
 * React StrictMode mounts an effect twice, and the second unmount must not
 * take the live subscription down with it. One occurrence in, one occurrence
 * out; the host hears `subscribe` when the array goes from empty and
 * `unsubscribe` when it goes back to empty.
 */
const bridgeListeners = new Map<string, Map<string, BridgeListener[]>>();

/**
 * One `bridge:event` listener for the whole page, fanned out locally.
 *
 * Installed once, at load: one IPC listener carries every pane's output and
 * every broadcast, so a renderer with forty subscriptions still has exactly
 * one listener on the channel.
 */
ipcRenderer.on(
  "bridge:event",
  (_event: Electron.IpcRendererEvent, frame: BridgeEventFrame) => {
    if (!frame || typeof frame.ns !== "string") return;
    const byKey = bridgeListeners.get(`${frame.ns}.${frame.event}`);
    if (!byKey) return;
    const args = Array.isArray(frame.args) ? frame.args : [];
    // A keyless event is about the machine (`projects.changed`), so every
    // listener of that name wants it. A keyed one is about one pane, and goes
    // to that pane's listeners plus anyone who subscribed without naming one.
    const lists =
      typeof frame.key === "string"
        ? [byKey.get(frame.key), byKey.get(BRIDGE_ALL_KEYS)]
        : [...byKey.values()];
    for (const list of lists) {
      if (!list) continue;
      for (const listener of [...list]) {
        try {
          listener(...args);
        } catch {
          // A listener that throws is that listener's problem; the rest of
          // the page still hears the event.
        }
      }
    }
  },
);

function bridgeSubscribe(
  ns: string,
  event: string,
  key: string | null | undefined,
  callback: BridgeListener,
): () => void {
  const name = `${ns}.${event}`;
  const slot = key ?? BRIDGE_ALL_KEYS;
  let byKey = bridgeListeners.get(name);
  if (!byKey) {
    byKey = new Map();
    bridgeListeners.set(name, byKey);
  }
  let list = byKey.get(slot);
  if (!list) {
    list = [];
    byKey.set(slot, list);
  }
  list.push(callback);
  if (list.length === 1) {
    ipcRenderer.send("bridge:subscribe", { ns, event, key: key ?? undefined });
  }

  // Idempotent: React calls a cleanup once, but a caller that keeps the
  // handle and calls it twice must not decrement somebody else's count.
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const current = bridgeListeners.get(name)?.get(slot);
    if (!current) return;
    const at = current.indexOf(callback);
    if (at !== -1) current.splice(at, 1);
    if (current.length > 0) return;
    const owner = bridgeListeners.get(name);
    owner?.delete(slot);
    if (owner?.size === 0) bridgeListeners.delete(name);
    ipcRenderer.send("bridge:unsubscribe", {
      ns,
      event,
      key: key ?? undefined,
    });
  };
}

contextBridge.exposeInMainWorld("manorHost", {
  platform: "electron",

  /**
   * The namespaces the preload still answers, and the root-level functions
   * alongside them. `src/bridge/client.ts` calls straight through to these
   * and only reaches `invoke` for what is *not* here (ADR-180 D3).
   */
  native: nativeApi,

  rendererId,
  isDetached,
  detachedWindowId,
  claim,

  env: {
    isPackaged,
  },

  /**
   * `ns.method(...args)` on the host's handler table.
   *
   * A failure comes back as a `{__bridgeError: {code, message}}` *value*
   * rather than a rejection: `ipcMain.handle` drops the custom properties of
   * a thrown error, and the `code` is what tells "the host does not do this"
   * from "the host tried and it broke". The client in the page turns the
   * envelope into the error it should be.
   */
  invoke: (ns: string, method: string, args: unknown[]) =>
    ipcRenderer.invoke("bridge:invoke", { ns, method, args }),

  /** Hear `ns.event` (for one `key`, or for all of them). Returns the undo. */
  subscribe: (
    ns: string,
    event: string,
    key: string | null,
    callback: BridgeListener,
  ) => bridgeSubscribe(ns, event, key, callback),
});
