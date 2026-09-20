import { contextBridge, ipcRenderer } from "electron";
import type { MenuCommandPayload, MenuContext } from "../src/lib/menu-commands";

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

/**
 * `onChannel`'s replacement for a push that is now a bridge event: one
 * `updater.<event>` subscription, typed at the call site (ADR-180 D5).
 */
function updaterEvent<T>(
  event: string,
  callback: (value: T) => void,
): () => void {
  return bridgeSubscribe("updater", event, null, (value) =>
    callback(value as T),
  );
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
//
// Asked on `bridge:rendererId` since `viewport` crossed to the handler table
// (ADR-180 ticket 6). It is the same question with the same answer — the
// window's connection id — put to the file that decides what a connection id
// is.
let rendererId: string | null = null;
try {
  const answer: unknown = ipcRenderer.sendSync("bridge:rendererId");
  rendererId = typeof answer === "string" ? answer : null;
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
  // `pty` is not here. It was the first namespace to cross (ADR-180 ticket
  // 5): eight methods that were `ipcRenderer.invoke("pty:*")` and six
  // subscriptions that were per-pane `webContents.send` channels are now
  // `bridge:invoke` and `bridge:subscribe` frames, keyed by paneId, answered
  // by the same table entries a paired device reaches. Nothing replaced them
  // here, and nothing should: a method written in this file is a method that
  // exists on one transport only (D8).
  //
  // `onWinsizeOwner` used to be a stub returning a no-op unsubscribe,
  // because the desktop could never lose the winsize. It can now — to
  // another window of its own (D6) — and the subscription that tells it so
  // is the same one a browser has always had.

  // `layout`, `viewport` and `projects` are not here either (ADR-180 ticket
  // 6). Seven layout methods that were already on the table lost their
  // `ipcMain.handle` wrappers; the viewport pair joined it as `LOCAL_ONLY`,
  // and every one of the twenty-three `projects` calls crossed with them.
  // `layout.onChanged` and `onProjectsChanged` are subscriptions to
  // `layout.changed` and `projects.changed` now, so the `layout:changed` and
  // `projects-changed` channels they listened on are gone from main too — a
  // namespace takes its legacy sends with it when it crosses.

  // `theme`, `preferences`, `keybindings`, `notifications` and `stats` are
  // gone the same way (ADR-180 ticket 7) — eighteen `ipcMain.handle`/`.on`
  // wrappers across four files, replaced by table entries and (for
  // `keybindings.set`/`reset`/`resetAll`/`runInMainWindow`) the first real
  // use `LOCAL_ONLY` gets. `theme.onChanged`, `preferences.onChange`,
  // `keybindings.onChange`, `keybindings.onForwardedCommand`,
  // `notifications.onChanged`, `notifications.onNavigate` and
  // `stats.onChanged` are subscriptions now, so `theme:changed`,
  // `preferences-changed`, `keybindings-changed`, `keybinding-command`,
  // `notifications:changed` and `stats:changed` are gone from main too —
  // `webview-keys.ts`'s forwarded "app" shortcut takes the same road, since
  // it is `keybindings.onForwardedCommand` a `<webview>` guest's key press
  // has always fed.

  // `ports`, `processes`, `branches` and `diffs` are gone the same way
  // (ADR-180 ticket 8) — twenty `ipcMain.handle` wrappers across three
  // files, replaced by table entries. `processes.killSession`, `killAll`,
  // `killDaemon` and `restartPortless` were deliberately absent from the
  // slice-1 table because they kill things; under D4 a `full` device already
  // reaches the same power through the route table, so they cross as
  // ordinary (`MUTATING`) entries rather than staying a hole. `ports.onChange`
  // and `branches`/`diffs`.`onChange` were already subscriptions to
  // `ports.changed`/`branches.changed`/`diffs.changed` before this ticket
  // (ADR-180 ticket 4), so there was no legacy send left to delete for them.
  // `git.*` stays here — it crosses with `github`/`linear`/`remoteControl`
  // under ticket 10.

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
    /**
     * The six `updater.*` broadcasts (ADR-180 D5), which `electron/updater.
     * ts` publishes instead of pushing at the primary window. Written out
     * here for the same reason `menu.onMenuCommand` is: `updater` is a
     * namespace the client refuses outright in a browser, so its
     * subscriptions have to be members of the native namespace.
     */
    onChecking: (callback: (payload: { manual: boolean }) => void) =>
      updaterEvent("checking", callback),
    onUpdateAvailable: (callback: (info: { version: string }) => void) =>
      updaterEvent("updateAvailable", callback),
    onUpdateDownloaded: (callback: (info: { version: string }) => void) =>
      updaterEvent("updateDownloaded", callback),
    onUpdateNotAvailable: (
      callback: (info: { version: string; manual: boolean }) => void,
    ) => updaterEvent("updateNotAvailable", callback),
    onDownloadProgress: (
      callback: (progress: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      }) => void,
    ) => updaterEvent("downloadProgress", callback),
    onError: (
      callback: (payload: { message: string; manual: boolean }) => void,
    ) => updaterEvent("error", callback),
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

  menu: {
    /** Pushes a fresh `MenuContext` snapshot so main can label/enable menu items. */
    setContext: (context: MenuContext) =>
      ipcRenderer.send("menu:setContext", context),
    /**
     * A native menu item was clicked; fire-and-forget, like a keybinding.
     *
     * A `menu.command` bridge event (ADR-180 D5), addressed by main to this
     * window's connection. It stays written out here rather than falling
     * through to `manorHost.subscribe` because `menu` is a namespace the
     * client refuses outright in a browser (`src/bridge/unavailable.ts`) —
     * the *invokes* are native forever, so the subscription has to be a
     * member of the native namespace too or the refusal would swallow it.
     */
    onMenuCommand: (callback: (payload: MenuCommandPayload) => void) =>
      bridgeSubscribe("menu", "command", null, (payload) =>
        callback(payload as MenuCommandPayload),
      ),
  },

  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke("clipboard:writeText", text),
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
