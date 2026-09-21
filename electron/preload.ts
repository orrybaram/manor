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

function onChannel<T>(
  channel: string,
  callback: (value: T) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** `onChannel`'s variant for a `webContents.send` with more than one argument. */
function onChannelArgs<Args extends unknown[]>(
  channel: string,
  callback: (...args: Args) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: Args) =>
    callback(...args);
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
 * `manorHost.native` — the namespaces `electron/ipc/` still answers itself
 * (ADR-180 D8, ticket 11): what ADR-178's "what can never leave the preload"
 * table named from the start, and nothing else. `src/bridge/client.ts` calls
 * straight through to these and reaches `invoke` for everything else —
 * `window.electronAPI` is built *over* this in the page, not exposed
 * straight from here, because a `Proxy` cannot cross `contextBridge`: the
 * bridge copies the shape it is handed, and a proxy's dynamic members are not
 * there to copy.
 *
 * Every other namespace this object used to carry — `pty`, `layout`,
 * `viewport`, `projects`, `theme`, `preferences`, `keybindings`,
 * `notifications`, `stats`, `ports`, `processes`, `branches`, `diffs`, `git`,
 * `github`, `linear`, `agents`, `remoteControl` — is a `bridge:invoke`/
 * `bridge:subscribe` frame now, answered by the same handler table entry a
 * paired device reaches (`electron/bridge/handlers.ts`). A method written in
 * this file is a method that exists on one transport only, which is why
 * nothing is added here without also being named in
 * `src/bridge/unavailable.ts`.
 *
 * The synchronous facts (`platform`, `rendererId`, `isDetached`,
 * `detachedWindowId`, `claim`, `env`) are *not* here: they are read off argv
 * above for that reason, and are the same values `ElectronAPI` reports.
 *
 * **This object is the list.** ADR-180 D7's check needs to know which methods
 * the preload serves, and a tuple of their names kept beside it would be one
 * more thing to keep in step — so `NativeMethod` in `electron/bridge/
 * surface.ts` is derived from `NativeApi` below instead, and writing a method
 * here *is* placing it. The type is exported; nothing about this file's
 * runtime crosses that import, which is why the check can read it without
 * dragging the main process into the renderer's bundle.
 */
const nativeApi = {
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
    onPickerResult: (callback: (paneId: string, result: unknown) => void) =>
      onChannelArgs("webview:picker-result", callback),
    onPickerCancel: (callback: (paneId: string) => void) =>
      onChannelArgs("webview:picker-cancel", callback),
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
    ) => onChannelArgs("webview:new-window", callback),
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
    ) => onChannelArgs("webview:loading-changed", callback),
    onFaviconUpdated: (
      callback: (paneId: string, faviconUrl: string) => void,
    ) => onChannelArgs("webview:favicon-updated", callback),
    onFindResult: (
      callback: (
        paneId: string,
        result: {
          activeMatchOrdinal: number;
          matches: number;
          finalUpdate: boolean;
        },
      ) => void,
    ) => onChannelArgs("webview:find-result", callback),
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
    ) => onChannelArgs("webview:audio-state-changed", callback),
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
 * The shape of `manorHost.native`, for the D7 surface check. A type, so the
 * import that reads it disappears at build time.
 */
export type NativeApi = typeof nativeApi;

/**
 * `window.manorHost` — the one concrete object the page builds a host client
 * over (ADR-180 D1–D3), and the only thing this file exposes. `ElectronAPI`
 * is not built here: `contextBridge` copies the shape it is handed, and the
 * `ns.method(...)` proxy `src/bridge/client.ts` builds over `invoke` has no
 * members to copy, so the page builds it the same way the web renderer
 * builds one over a WebSocket.
 *
 * The four channel names below are written out rather than imported from
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
