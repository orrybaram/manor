import { contextBridge, ipcRenderer } from "electron";
import type { PickedElementResult } from "../src/electron";
import type { MenuContext } from "../src/lib/menu-commands";
import type { RecordingCommand } from "../src/lib/webview-recorder";
import type { BridgeEvents } from "./bridge/events";

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `ipcRenderer.invoke`, typed. `NativeApi` is derived from the object below,
 * so what each channel resolves with is written here, once, or nowhere.
 */
function invoke<T = void>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
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
 * A bridge event heard by a native namespace (ADR-180 D5): `updater.*` and
 * `menu.command`, typed by their row in `BridgeEvents`.
 */
function nativeEvent<
  N extends "updater" | "menu",
  E extends keyof BridgeEvents[N] & string,
>(
  ns: N,
  event: E,
  callback: (...args: BridgeEvents[N][E] & unknown[]) => void,
): () => void {
  return bridgeSubscribe(ns, event, null, (...args) =>
    callback(...(args as BridgeEvents[N][E] & unknown[])),
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
 * **This object is the list, and the signatures.** `ElectronAPI`'s native
 * part is `NativeApi` below (`src/electron.d.ts`), so writing a method here
 * *is* declaring it, with the types written on it — which is why every
 * `invoke` names what its channel resolves with. The type is exported;
 * nothing about this file's runtime crosses that import, which is why the
 * renderer can read it without dragging the main process into its bundle.
 */
const nativeApi = {
  dialog: {
    openDirectory: () => invoke<string | null>("dialog:openDirectory"),
  },

  shell: {
    openExternal: (url: string) => invoke("shell:openExternal", url),
    openInEditor: (path: string) =>
      invoke<string>("shell:openInEditor", path),
    resolveFilePath: (filePath: string, cwd: string) =>
      invoke<string | null>("shell:resolveFilePath", filePath, cwd),
    discoverAgents: () =>
      invoke<Array<{ name: string; command: string }>>("shell:discoverAgents"),
    showItemInFolder: (path: string) => invoke("shell:showItemInFolder", path),
  },

  updater: {
    checkForUpdates: () => invoke("updater:checkForUpdates"),
    quitAndInstall: () => invoke("updater:quitAndInstall"),
    /**
     * The six `updater.*` broadcasts (ADR-180 D5), which `electron/updater.
     * ts` publishes instead of pushing at the primary window. Written out
     * here for the same reason `menu.onMenuCommand` is: `updater` is a
     * namespace the client refuses outright in a browser, so its
     * subscriptions have to be members of the native namespace.
     */
    onChecking: (
      callback: (...args: BridgeEvents["updater"]["checking"]) => void,
    ) => nativeEvent("updater", "checking", callback),
    onUpdateAvailable: (
      callback: (...args: BridgeEvents["updater"]["updateAvailable"]) => void,
    ) => nativeEvent("updater", "updateAvailable", callback),
    onUpdateDownloaded: (
      callback: (...args: BridgeEvents["updater"]["updateDownloaded"]) => void,
    ) => nativeEvent("updater", "updateDownloaded", callback),
    onUpdateNotAvailable: (
      callback: (...args: BridgeEvents["updater"]["updateNotAvailable"]) => void,
    ) => nativeEvent("updater", "updateNotAvailable", callback),
    onDownloadProgress: (
      callback: (...args: BridgeEvents["updater"]["downloadProgress"]) => void,
    ) => nativeEvent("updater", "downloadProgress", callback),
    onError: (callback: (...args: BridgeEvents["updater"]["error"]) => void) =>
      nativeEvent("updater", "error", callback),
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
    onMenuCommand: (
      callback: (...args: BridgeEvents["menu"]["command"]) => void,
    ) => nativeEvent("menu", "command", callback),
  },

  clipboard: {
    writeText: (text: string) => invoke("clipboard:writeText", text),
  },

  webview: {
    register: (paneId: string, webContentsId: number) =>
      invoke("webview:register", paneId, webContentsId),
    unregister: (paneId: string) => invoke("webview:unregister", paneId),
    startPicker: (paneId: string) => invoke("webview:start-picker", paneId),
    cancelPicker: (paneId: string) => invoke("webview:cancel-picker", paneId),
    zoomIn: (paneId: string) => invoke("webview:zoom-in", paneId),
    zoomOut: (paneId: string) => invoke("webview:zoom-out", paneId),
    zoomReset: (paneId: string) => invoke("webview:zoom-reset", paneId),
    onPickerResult: (
      callback: (paneId: string, result: PickedElementResult) => void,
    ) => onChannelArgs("webview:picker-result", callback),
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
    stop: (paneId: string) => invoke("webview:stop", paneId),
    findInPage: (
      paneId: string,
      query: string,
      options?: { forward?: boolean; findNext?: boolean },
    ) => invoke("webview:find-in-page", paneId, query, options),
    stopFindInPage: (paneId: string) =>
      invoke("webview:stop-find-in-page", paneId),
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
      invoke("webview:set-audio-muted", paneId, muted),
    /**
     * One webm chunk from a pane's `MediaRecorder` (ADR-158). `send`, not
     * `invoke`: chunks arrive once a second per recording and main has nothing
     * useful to answer.
     */
    sendRecordingChunk: (recordingId: string, chunk: ArrayBuffer) =>
      ipcRenderer.send("webview:recording-chunk", recordingId, chunk),
    /** Renderer's recorder has flushed; main may finalize the file. */
    notifyRecordingStopped: (recordingId: string, error?: string) =>
      invoke("webview:recording-stopped", recordingId, error),
    /** Main-initiated start/stop of a pane recording. */
    onRecordingCommand: (callback: (command: RecordingCommand) => void) =>
      onChannel("webview:recording-command", callback),
    /** User clicked the pane's "Recording" indicator to stop it (ADR-158). */
    stopRecording: (paneId: string) => invoke("webview:stop-recording", paneId),
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
    ) => invoke<string>("window:detachTab", workspacePath, tabId, spawnBounds),
    getBounds: () => invoke<WindowBounds>("window:getBounds"),
    setPosition: (x: number, y: number) =>
      ipcRenderer.send("window:setPosition", x, y),
    listWindows: () =>
      invoke<{ id: number; bounds: WindowBounds }[]>("window:listWindows"),
    closeSelf: () => ipcRenderer.send("window:closeSelf"),
  },
};

/**
 * The shape of `manorHost.native`, and the native part of `ElectronAPI`
 * (`src/electron.d.ts`). A type, so the import that reads it disappears at
 * build time.
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
