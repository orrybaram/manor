/**
 * `electron/ipc/` — what only Electron can do.
 *
 * Everything that could be answered the same way for a renderer window and a
 * paired `full` device has crossed to `electron/bridge/handlers.ts` and its
 * implementation under `electron/bridge/handlers/`. What is left here is the
 * set named from the start as what can never leave the preload:
 *
 *   - `<webview>` and its 27 methods (this file, `webview-keys.ts`)
 *   - detach-to-window (`window.ts`, `popups.ts`)
 *   - the native application menu (`menu.ts`)
 *   - native dialogs, the shell escape hatches, the machine clipboard and the
 *     updater (`native.ts`)
 *
 * A `<webview>` guest is not a renderer window and a `Menu` is not a frame a
 * socket can carry, so none of these has a "make it a table entry" version —
 * they are `unavailable:web` on the bridge (`src/bridge/unavailable.ts`)
 * because there is nothing else honest to answer. `electron/ipc/types.ts`
 * survives alongside them because `HostDeps` is what both this file's
 * `register()` calls and the handler table's entries take as their first
 * argument.
 */
import {
  app,
  ipcMain,
  Menu,
  webContents,
  dialog,
  BrowserWindow,
  clipboard,
} from "electron";
import { assertString } from "../ipc-validate";
import { recordingManager } from "../recording-manager";
import { WebviewServer } from "../webview-server";
import type { HostDeps } from "./types";
import {
  comboMatches,
  resolveBindings,
  type KeyCombo,
} from "../../src/lib/keybinding-defs";
import { isDockRect } from "../../src/lib/devtools-dock";
import { BrowserDevToolsDock, type DockTarget } from "../browser-devtools-dock";
import { comboFromInputEvent, createPageKeyHandler } from "./webview-keys";
import { attachPageDialogs, registerPageDialogIpc } from "../webview-dialogs";
import { attachPagePins, registerPagePinsIpc } from "../webview-pins";
import { buildPageContextMenu } from "../webview-context-menu";
import {
  buildPopupWindowOptions,
  closeAllChildWindows,
  closeChildWindowsForPane,
  registerChildWindow,
} from "./popups";

// Re-exported so callers (e.g. main-window lifecycle) can flush all tracked
// child popup windows without importing the popups module directly.
export { closeAllChildWindows };

export const webviewRegistry = new Map<string, number>();

// Re-exported so the HTTP routes can start/stop recordings without
// reaching past this module for the shared instance.
export { recordingManager };

/**
 * paneId → webContents id of the *renderer* that hosts the pane (not the
 * webview's own webContents, which is what `webviewRegistry` holds). Recording
 * commands must go to the window that owns the pane: a pane popped out into a
 * detached window is not driven by the main window's renderer.
 */
const paneRenderers = new Map<string, number>();

/**
 * The webContents of the renderer window hosting `paneId`. `MediaRecorder`
 * runs in that renderer (via `window.electronAPI`, not exposed to arbitrary
 * guest page content), so it — not the pane's own `webContents` — is the
 * `requestWebContents` argument `wc.getMediaSourceId()` needs. Exported for
 * the `record/start` route.
 */
export function getPaneRendererWebContents(
  paneId: string,
): Electron.WebContents | undefined {
  const rendererId = paneRenderers.get(paneId);
  if (rendererId === undefined) return undefined;
  const rendererWc = webContents.fromId(rendererId);
  return rendererWc && !rendererWc.isDestroyed() ? rendererWc : undefined;
}

const webviewContextMenuCleanup = new Map<string, () => void>();
const webviewEscapeCleanup = new Map<string, () => void>();
const webviewUnloadCleanup = new Map<string, () => void>();
const webviewEventCleanup = new Map<string, () => void>();
const webviewAudioCleanup = new Map<string, () => void>();
const webviewPopupCleanup = new Map<string, () => void>();
const webviewDialogCleanup = new Map<string, () => void>();
const webviewPinsCleanup = new Map<string, () => void>();

// ── Docked DevTools ──

/** The key that toggles a page's DevTools, kept current by `register`. */
let devToolsBinding: KeyCombo | undefined;

/**
 * The app menu's Toggle Developer Tools accelerator (`app-menu-template.ts`),
 * which already reaches a focused frontend and toggles its pane's DevTools.
 * Acting on it here too would close them twice over, and the second toggle
 * could reopen them.
 */
const MENU_DEVTOOLS_COMBO: KeyCombo =
  process.platform === "darwin"
    ? { key: "i", meta: true, alt: true, ctrl: false, shift: false }
    : { key: "i", ctrl: true, shift: true, meta: false, alt: false };

/** Every open docked DevTools; see `browser-devtools-dock.ts`. */
const devToolsDock = new BrowserDevToolsDock({
  onChange(paneId, host, open) {
    if (!host.isDestroyed()) host.send("webview:devtools-changed", paneId, open);
  },
  // A DevTools frontend is no page: its keys reach neither the page's
  // `before-input-event` nor the app's renderer. Watch it for the toggle key
  // so the same shortcut closes DevTools from inside them.
  onFrontend(paneId, frontend) {
    frontend.on("input-event", (_event, input) => {
      const combo = comboFromInputEvent(input);
      if (!combo || !devToolsBinding || !comboMatches(combo, devToolsBinding)) return;
      if (comboMatches(combo, MENU_DEVTOOLS_COMBO)) return;
      // Let the key finish routing before the frontend is torn down under it.
      setImmediate(() => void devToolsDock.close(paneId));
    });
  },
});

/** The page, renderer and window of `paneId`, or null if any is gone. */
function devToolsTarget(paneId: string): DockTarget | null {
  const guestId = webviewRegistry.get(paneId);
  const guest = guestId !== undefined ? webContents.fromId(guestId) : undefined;
  const host = getPaneRendererWebContents(paneId);
  const window = host ? BrowserWindow.fromWebContents(host) : null;
  if (!guest || guest.isDestroyed() || !host || !window || window.isDestroyed()) {
    return null;
  }
  return { guest, host, window };
}

/**
 * Open `paneId`'s DevTools docked in the pane, then inspect the element at
 * `inspectAt` if given. Docking comes first: `inspectElement` on its own
 * opens Electron's DevTools window and bypasses the dock.
 */
async function openDevTools(
  paneId: string,
  inspectAt?: { x: number; y: number },
): Promise<boolean> {
  const target = devToolsTarget(paneId);
  if (!target) return false;
  const opened = await devToolsDock.open(paneId, target);
  if (opened && inspectAt && !target.guest.isDestroyed()) {
    target.guest.inspectElement(inspectAt.x, inspectAt.y);
  }
  return opened;
}

function toggleDevTools(paneId: string): void {
  if (devToolsDock.isOpen(paneId)) void devToolsDock.close(paneId);
  else void openDevTools(paneId);
}

/**
 * The app menu's Toggle Developer Tools while `focused` is a browser pane's
 * page or its docked DevTools: toggles that pane's. False when `focused` is
 * neither, so the menu toggles the window's own instead.
 */
export function toggleFocusedPageDevTools(focused: Electron.WebContents): boolean {
  for (const [paneId, guestId] of webviewRegistry) {
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed()) continue;
    if (guest !== focused && guest.devToolsWebContents !== focused) continue;
    toggleDevTools(paneId);
    return true;
  }
  return false;
}

export function createWebviewServer(getDeps: () => HostDeps): WebviewServer {
  return new WebviewServer(webviewRegistry, getDeps);
}

// ── Recording ──

/** Payload of the main→renderer "webview:recording-command" channel. */
interface RecordingCommand {
  cmd: "start" | "stop";
  recordingId: string;
  /** Chromium media source id of the pane's webview. Required for "start". */
  mediaSourceId?: string;
  /**
   * Pane this command is for. The renderer needs it to drive a per-pane
   * "Recording" indicator — `sendRecordingCommand` already
   * routes to the right window by paneId, but the payload itself didn't carry
   * it until then.
   */
  paneId: string;
}

/**
 * Cap on chunks held here while the disk catches up. Past this, the disk is
 * losing to the encoder and the gap will only widen; stopping the recording
 * beats growing main's heap without limit. ~30s of a high-bitrate capture.
 */
const MAX_QUEUED_CHUNK_BYTES = 32 * 1024 * 1024;

/** How long to wait for the renderer to confirm its recorder flushed. */
const RENDERER_STOP_TIMEOUT_MS = 5000;

/**
 * How long to wait for the renderer to report a *failed* start before
 * assuming it succeeded. `getUserMedia`/`MediaRecorder` setup failures
 * (bad `mediaSourceId`, permission denial) surface almost immediately, so
 * this only needs to outlast that — not the recording itself.
 */
const RENDERER_START_CONFIRM_TIMEOUT_MS = 5000;

interface ChunkQueue {
  /** Chunks held back while the write stream is over its high-water mark. */
  pending: Buffer[];
  bytes: number;
  draining: boolean;
}

const chunkQueues = new Map<string, ChunkQueue>();

/** Resolvers for `webview:recording-stopped`, keyed by recordingId. */
const pendingStopConfirmations = new Map<string, () => void>();

/**
 * Resolvers for a start's failure notification, keyed by recordingId. Only
 * populated while `startRendererRecording`'s returned promise is pending; a
 * "webview:recording-stopped" that arrives after it settled (or a later,
 * unrelated stop) instead falls through to the normal self-cleanup path.
 */
const pendingStartConfirmations = new Map<string, (error?: string) => void>();

function queueFor(recordingId: string): ChunkQueue {
  let queue = chunkQueues.get(recordingId);
  if (!queue) {
    queue = { pending: [], bytes: 0, draining: false };
    chunkQueues.set(recordingId, queue);
  }
  return queue;
}

/**
 * Write everything queued for a recording, ignoring backpressure, and forget
 * the queue. Called on the stop path: the stream's `end()` flushes whatever is
 * buffered, so a last unthrottled write is safe — and dropping these chunks
 * would truncate the webm.
 */
function flushChunkQueue(recordingId: string): void {
  const queue = chunkQueues.get(recordingId);
  chunkQueues.delete(recordingId);
  if (!queue) return;
  for (const chunk of queue.pending) {
    recordingManager.appendChunk(recordingId, chunk);
  }
}

/**
 * Feed the queue back into the stream as it drains. Runs until the queue is
 * empty and a write succeeds without backpressure.
 */
async function drainChunkQueue(recordingId: string): Promise<void> {
  for (;;) {
    await recordingManager.waitForDrain(recordingId);
    const queue = chunkQueues.get(recordingId);
    if (!queue) return; // recording stopped while we waited
    let ok = true;
    while (ok && queue.pending.length > 0) {
      const chunk = queue.pending.shift()!;
      queue.bytes -= chunk.length;
      ok = recordingManager.appendChunk(recordingId, chunk);
    }
    if (ok) {
      // Caught up. Drop the queue entirely so the map does not accumulate an
      // empty entry per recording for the life of the process.
      queue.draining = false;
      if (queue.pending.length === 0) chunkQueues.delete(recordingId);
      return;
    }
  }
}

/**
 * Take one chunk from the renderer, respecting the write stream's
 * backpressure. Chunks are never dropped — a hole in a webm corrupts the file —
 * so an over-budget queue stops the recording instead.
 */
function acceptChunk(recordingId: string, chunk: Buffer): void {
  const queue = chunkQueues.get(recordingId);

  if (queue?.draining) {
    queue.pending.push(chunk);
    queue.bytes += chunk.length;
    if (queue.bytes > MAX_QUEUED_CHUNK_BYTES) {
      console.error(
        `[recording] ${recordingId}: disk cannot keep up (${queue.bytes} bytes queued); stopping.`,
      );
      chunkQueues.delete(recordingId);
      void stopRecording(recordingId);
    }
    return;
  }

  // Only allocate a queue once the stream actually asks us to back off.
  if (!recordingManager.appendChunk(recordingId, chunk)) {
    queueFor(recordingId).draining = true;
    void drainChunkQueue(recordingId);
  }
}

/** Send a recording command to the renderer that hosts `paneId`. */
function sendRecordingCommand(paneId: string, command: RecordingCommand): void {
  const rendererId = paneRenderers.get(paneId);
  const target = rendererId !== undefined ? webContents.fromId(rendererId) : null;
  if (target && !target.isDestroyed()) {
    target.send("webview:recording-command", command);
    return;
  }
  // The pane's renderer is gone (window closed mid-recording); fall back to the
  // first window so a stop still has a chance of reaching the recorder.
  const fallback = BrowserWindow.getAllWindows()[0];
  fallback?.webContents.send("webview:recording-command", command);
}

/** Outcome of a `startRendererRecording` round-trip. */
export type StartRendererRecordingResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Tell the renderer to start capturing `paneId` into `recordingId`, and wait
 * to see whether it reports an immediate failure.
 *
 * The renderer has nothing to say on success — the `MediaRecorder` just runs —
 * so this can only ever confirm a *failure*: a `webview:recording-stopped`
 * call for this id before the timeout elapses. No such call within the window
 * is treated as success. The start route relies on this to roll back a
 * registered recording that never got a `MediaRecorder` behind it.
 */
export function startRendererRecording(
  recordingId: string,
  paneId: string,
  mediaSourceId: string,
): Promise<StartRendererRecordingResult> {
  const confirmed = new Promise<StartRendererRecordingResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingStartConfirmations.delete(recordingId);
      resolve({ ok: true });
    }, RENDERER_START_CONFIRM_TIMEOUT_MS);
    pendingStartConfirmations.set(recordingId, (error) => {
      clearTimeout(timer);
      pendingStartConfirmations.delete(recordingId);
      resolve({ ok: false, error: error ?? "Renderer failed to start recording" });
    });
  });
  sendRecordingCommand(paneId, { cmd: "start", recordingId, mediaSourceId, paneId });
  return confirmed;
}

/**
 * Tell the renderer to stop its `MediaRecorder` and wait for it to confirm the
 * flush, so the trailing chunk lands before the file is finalized. Resolves on
 * timeout too — a wedged renderer must not block finalization forever.
 */
export function stopRendererRecording(
  recordingId: string,
  paneId: string,
  timeoutMs = RENDERER_STOP_TIMEOUT_MS,
): Promise<void> {
  const confirmed = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pendingStopConfirmations.delete(recordingId);
      resolve();
    }, timeoutMs);
    pendingStopConfirmations.set(recordingId, () => {
      clearTimeout(timer);
      pendingStopConfirmations.delete(recordingId);
      resolve();
    });
  });
  sendRecordingCommand(paneId, { cmd: "stop", recordingId, paneId });
  return confirmed;
}

/**
 * Full stop: drain the renderer first, then finalize the file. This is what
 * the HTTP routes and the teardown paths should call.
 */
export async function stopRecording(recordingId: string, timeoutMs?: number) {
  const paneId = recordingManager
    .list()
    .find((r) => r.recordingId === recordingId)?.paneId;
  if (paneId) await stopRendererRecording(recordingId, paneId, timeoutMs);
  flushChunkQueue(recordingId);
  return recordingManager.stop(recordingId);
}

export function register(deps: HostDeps): void {
  function getMainWindow() {
    return deps.mainWindow;
  }

  // The merged keybinding map pages match keys against, kept in step with the
  // user's edits so a rebound shortcut works from a page straight away.
  const bindingPlatform = process.platform === "darwin" ? "MacIntel" : "other";
  let pageBindings = resolveBindings(
    deps.keybindingsManager.getAll(),
    bindingPlatform,
  ).bindings;
  devToolsBinding = pageBindings["browser-devtools"];
  deps.keybindingsManager.onChange((overrides) => {
    pageBindings = resolveBindings(overrides, bindingPlatform).bindings;
    devToolsBinding = pageBindings["browser-devtools"];
  });

  registerPageDialogIpc();
  registerPagePinsIpc((paneId) => {
    const id = webviewRegistry.get(paneId);
    const page = id !== undefined ? webContents.fromId(id) : undefined;
    return page && !page.isDestroyed() ? page : null;
  }, deps.backendRegistry);

  ipcMain.handle(
    "webview:register",
    (
      _event,
      paneId: string,
      webContentsId: number,
      remoteHostId?: string | null,
    ) => {
      assertString(paneId, "paneId");
      webviewRegistry.set(paneId, webContentsId);
      deps.webviewServer.attachConsoleListener(paneId);
      // A remote workspace's pane: agent `navigate`s to the box's
      // `localhost:<port>` go through its port forward. The
      // map is main-owned — `resolvePaneUrl` reads it directly.
      if (typeof remoteHostId === "string" && remoteHostId) {
        deps.paneHosts.set(paneId, remoteHostId);
      } else {
        deps.paneHosts.delete(paneId);
      }

      const rendererWebContents = _event.sender;
      paneRenderers.set(paneId, rendererWebContents.id);

      const wc = webContents.fromId(webContentsId);
      if (wc) {
        const handler = (
          _ev: Electron.Event,
          params: Electron.ContextMenuParams,
        ) => {
          const template = buildPageContextMenu(params, {
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
            goBack: () => wc.navigationHistory.goBack(),
            goForward: () => wc.navigationHistory.goForward(),
            reload: () => wc.reload(),
            openInNewTab: (url) =>
              rendererWebContents.send("webview:new-window", paneId, url),
            // The renderer owns the layout: it splits the pane.
            openInSplit: (url) =>
              rendererWebContents.send("webview:open-in-split", paneId, url),
            copyText: (text) => clipboard.writeText(text),
            cut: () => wc.cut(),
            copy: () => wc.copy(),
            paste: () => wc.paste(),
            selectAll: () => wc.selectAll(),
            saveImageAs: async (url) => {
              const win = BrowserWindow.fromWebContents(rendererWebContents);
              if (!win || win.isDestroyed()) return;
              const result = await dialog.showSaveDialog(win, {
                defaultPath: new URL(url).pathname.split("/").pop() || "image",
              });
              if (!result.canceled && result.filePath) {
                wc.downloadURL(url);
                wc.session.once("will-download", (_e, item) => {
                  item.setSavePath(result.filePath!);
                });
              }
            },
            copyImageAt: (x, y) => wc.copyImageAt(x, y),
            // Docked in the pane, then inspecting: see `openDevTools`.
            inspectElement: (x, y) => void openDevTools(paneId, { x, y }),
          });
          Menu.buildFromTemplate(template).popup();
        };
        wc.on("context-menu", handler);
        webviewContextMenuCleanup.set(paneId, () => {
          wc.off("context-menu", handler);
        });

        // Double-Escape, the browser's own keys, and every other bound combo
        // (forwarded to the app) — see webview-keys.ts.
        const escapeHandler = createPageKeyHandler({
          paneId,
          page: wc,
          host: rendererWebContents,
          getBindings: () => pageBindings,
        });
        wc.on("before-input-event", escapeHandler);
        webviewEscapeCleanup.set(paneId, () => {
          wc.off("before-input-event", escapeHandler);
        });

        const loadingStartHandler = () => {
          rendererWebContents.send("webview:loading-changed", paneId, true);
        };
        const loadingStopHandler = () => {
          rendererWebContents.send("webview:loading-changed", paneId, false);
        };
        wc.on("did-start-loading", loadingStartHandler);
        wc.on("did-stop-loading", loadingStopHandler);

        const faviconHandler = (_ev: Electron.Event, favicons: string[]) => {
          if (favicons.length > 0) {
            rendererWebContents.send("webview:favicon-updated", paneId, favicons[0]);
          }
        };
        wc.on("page-favicon-updated", faviconHandler);

        const findResultHandler = (_ev: Electron.Event, result: Electron.FoundInPageResult) => {
          rendererWebContents.send("webview:find-result", paneId, {
            activeMatchOrdinal: result.activeMatchOrdinal,
            matches: result.matches,
            finalUpdate: result.finalUpdate,
          });
        };
        wc.on("found-in-page", findResultHandler);

        const audioPlayingHandler = (_ev: Electron.Event & { audible: boolean }) => {
          rendererWebContents.send("webview:audio-state-changed", paneId, _ev.audible);
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wc.on("audio-state-changed", audioPlayingHandler as any);

        webviewEventCleanup.set(paneId, () => {
          wc.off("did-start-loading", loadingStartHandler);
          wc.off("did-stop-loading", loadingStopHandler);
          wc.off("page-favicon-updated", faviconHandler);
          wc.off("found-in-page", findResultHandler);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          wc.off("audio-state-changed", audioPlayingHandler as any);
        });

        // New-window handling via Electron's native open path. This requires the
        // <webview> to carry the `allowpopups` attribute (see BrowserPane.tsx);
        // without it the guest's window.open is blocked before this handler runs.
        //
        // Routing is by intent, keyed on `disposition` / `features`:
        //
        //   Observed disposition mapping (Electron 35, from docs — NOT yet
        //   verified empirically in-app):
        //   - <a target="_blank"> click          -> "foreground-tab"
        //   - cmd/ctrl+click, middle-click        -> "background-tab"
        //   - window.open(url)  (no features)     -> "foreground-tab"
        //   - window.open(url, name, "width=…")   -> "new-window" / features set
        //   - window.open(url, "_self"|"_parent"|"_top")
        //         -> does NOT reach this handler; surfaces as will-navigate on
        //            the guest and navigates in place (bug #1 fix).
        //   - window.open from inside an <iframe>  -> reaches this handler now
        //         that allowpopups is set (bug #2 fix).
        //
        // Navigation-style opens (foreground-tab / background-tab) become manor
        // tabs. Communicating popups (new-window disposition and/or non-empty
        // features) are allowed through as a real, managed child BrowserWindow
        // so the Chromium opener relationship (window.opener, postMessage,
        // closed, close(), named reuse) is preserved end-to-end.
        wc.setWindowOpenHandler(({ url, disposition, features }) => {
          if (disposition === "foreground-tab" || disposition === "background-tab") {
            rendererWebContents.send("webview:new-window", paneId, url, {
              background: disposition === "background-tab",
            });
            return { action: "deny" };
          }

          // Communicating popup (OAuth/SSO/payment): disposition "new-window"
          // and/or window features requesting a sized popup. Allow Chromium to
          // create a child window (parented to the main window, secure
          // webPreferences, normalized size). The child is captured in
          // `did-create-window` below and tracked for cleanup.
          // Parent to the window that actually owns this pane. A pane popped out
          // into a detached window is not the main window's child, and parenting
          // its popup to the main window (or, once that window is closed, to a
          // destroyed one) wires the popup to the wrong native window.
          const owner =
            BrowserWindow.fromWebContents(rendererWebContents) ??
            getMainWindow();
          return {
            action: "allow",
            overrideBrowserWindowOptions: buildPopupWindowOptions(
              owner,
              features,
            ),
          };
        });

        // Capture the child window created by the allow branch above so it can
        // be tracked, given its own external-link policy, and cleaned up when
        // the pane is unregistered or the main window closes.
        const didCreateWindowHandler = (childWindow: Electron.BrowserWindow) => {
          registerChildWindow(paneId, childWindow);
        };
        wc.on("did-create-window", didCreateWindowHandler);
        webviewPopupCleanup.set(paneId, () => {
          wc.off("did-create-window", didCreateWindowHandler);
          closeChildWindowsForPane(paneId);
        });

        // Handle beforeunload — show a native confirm dialog when the page
        // tries to prevent navigation (e.g. unsaved changes warnings).
        const preventUnloadHandler = (event: Electron.Event) => {
          const host = BrowserWindow.fromWebContents(wc.hostWebContents ?? wc);
          // Falls back to a parentless dialog rather than a destroyed window:
          // this fires *during* teardown, exactly when the host — or a closed
          // main window — is most likely to be gone already.
          const owner = host ?? getMainWindow();
          const options: Electron.MessageBoxSyncOptions = {
            type: "question",
            buttons: ["Leave", "Stay"],
            defaultId: 1,
            cancelId: 1,
            title: "Leave site?",
            message: "Changes you made may not be saved.",
          };
          const choice =
            owner && !owner.isDestroyed()
              ? dialog.showMessageBoxSync(owner, options)
              : dialog.showMessageBoxSync(options);
          if (choice === 0) {
            event.preventDefault(); // allow navigation
          }
        };
        wc.on("will-prevent-unload", preventUnloadHandler);

        webviewUnloadCleanup.set(paneId, () => {
          wc.off("will-prevent-unload", preventUnloadHandler);
        });

        // alert/confirm/prompt as an overlay in the pane — see webview-dialogs.ts.
        webviewDialogCleanup.get(paneId)?.();
        webviewDialogCleanup.set(
          paneId,
          attachPageDialogs(paneId, wc, rendererWebContents),
        );

        // Picks, pin clicks and pin positions — see webview-pins.ts.
        webviewPinsCleanup.get(paneId)?.();
        webviewPinsCleanup.set(
          paneId,
          attachPagePins(paneId, wc, rendererWebContents, deps.backendRegistry),
        );
      }
    },
  );

  ipcMain.handle("webview:unregister", (_event, paneId: string) => {
    assertString(paneId, "paneId");
    // Only the renderer that owns the pane's DevTools closes them: a pane torn
    // off to another window may have registered there first.
    if (devToolsDock.hostOf(paneId) === _event.sender) {
      void devToolsDock.close(paneId);
    }
    webviewContextMenuCleanup.get(paneId)?.();
    webviewContextMenuCleanup.delete(paneId);
    webviewEscapeCleanup.get(paneId)?.();
    webviewEscapeCleanup.delete(paneId);
    webviewUnloadCleanup.get(paneId)?.();
    webviewUnloadCleanup.delete(paneId);
    webviewEventCleanup.get(paneId)?.();
    webviewEventCleanup.delete(paneId);
    webviewAudioCleanup.get(paneId)?.();
    webviewAudioCleanup.delete(paneId);
    webviewPopupCleanup.get(paneId)?.();
    webviewPopupCleanup.delete(paneId);
    webviewDialogCleanup.get(paneId)?.();
    webviewDialogCleanup.delete(paneId);
    webviewPinsCleanup.get(paneId)?.();
    webviewPinsCleanup.delete(paneId);
    deps.webviewServer.detachConsoleListener(paneId);
    deps.paneHosts.delete(paneId);
    webviewRegistry.delete(paneId);
    // The pane is going away, so nothing will ever produce another chunk for
    // it: flush what is queued and finalize, rather than orphan the file. No
    // renderer round-trip — its recorder died with the pane.
    const recording = recordingManager
      .list()
      .find((r) => r.paneId === paneId);
    if (recording) {
      flushChunkQueue(recording.recordingId);
      void recordingManager.stopForPane(paneId);
    }
    paneRenderers.delete(paneId);
  });

  ipcMain.handle("webview:open-devtools", (_event, paneId: string) => {
    assertString(paneId, "paneId");
    return openDevTools(paneId);
  });

  ipcMain.handle("webview:close-devtools", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    await devToolsDock.close(paneId);
  });

  // Where the pane's DevTools slot is (window CSS pixels), or null to hide
  // the view; with `snapshot`, answers the hidden view's last frame.
  ipcMain.handle(
    "webview:set-devtools-bounds",
    (event, paneId: string, slot: unknown, snapshot: unknown) => {
      assertString(paneId, "paneId");
      if (slot !== null && !isDockRect(slot)) {
        throw new Error("slot must be a rect or null");
      }
      if (devToolsDock.hostOf(paneId) !== event.sender) return null;
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;
      return devToolsDock.setBounds(paneId, window, slot, snapshot === true);
    },
  );

  ipcMain.handle("webview:zoom-in", (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
  });

  ipcMain.handle("webview:zoom-out", (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
  });

  ipcMain.handle("webview:zoom-reset", (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.setZoomLevel(0);
  });

  ipcMain.handle("webview:stop", (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.stop();
  });

  // The pane's error and waiting pages retry a load here rather than through
  // the element, whose `loadURL` logs every failure as an IPC handler error.
  ipcMain.handle("webview:load-url", (_event, paneId: string, url: string) => {
    assertString(paneId, "paneId");
    assertString(url, "url");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    // A failure is the page's `did-fail-load`, which the pane already hears.
    wc.loadURL(url).catch(() => {});
  });

  ipcMain.handle("webview:find-in-page", (_event, paneId: string, query: string, options?: { forward?: boolean; findNext?: boolean }) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.findInPage(query, options);
  });

  ipcMain.handle("webview:stop-find-in-page", (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.stopFindInPage("clearSelection");
  });

  ipcMain.handle("webview:set-audio-muted", (_event, paneId: string, muted: boolean) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.setAudioMuted(muted);
  });

  // ── Recording ──

  // `on`, not `handle`: chunks are fire-and-forget. A round-trip per second per
  // recording would buy nothing — backpressure is handled by `acceptChunk`.
  ipcMain.on(
    "webview:recording-chunk",
    (_event, recordingId: string, chunk: ArrayBuffer) => {
      assertString(recordingId, "recordingId");
      if (!chunk) return;
      acceptChunk(recordingId, Buffer.from(chunk));
    },
  );

  // The renderer's recorder has flushed. One of three callers is waiting: a
  // `stopRendererRecording` round-trip, a `startRendererRecording` round-trip
  // reporting an immediate failure, or nobody — the recorder stopped on its
  // own (failed capture, destroyed webview) and main has to finalize now.
  ipcMain.handle(
    "webview:recording-stopped",
    (_event, recordingId: string, error?: string) => {
      assertString(recordingId, "recordingId");
      if (error) {
        console.error(`[recording] renderer stopped ${recordingId}: ${error}`);
      }
      flushChunkQueue(recordingId);
      const stopConfirm = pendingStopConfirmations.get(recordingId);
      if (stopConfirm) {
        stopConfirm();
        return;
      }
      const startConfirm = pendingStartConfirmations.get(recordingId);
      if (startConfirm) {
        startConfirm(error);
        return;
      }
      void recordingManager.stop(recordingId);
    },
  );

  // The user clicked the pane's "Recording" indicator — the
  // one way out that does not require asking the agent to stop. Reuses the
  // exact same drain-then-finalize path as the MCP `stop_recording` tool.
  ipcMain.handle("webview:stop-recording", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const recording = recordingManager.list().find((r) => r.paneId === paneId);
    if (!recording) return;
    await stopRecording(recording.recordingId);
  });

  // A `maxDurationSec` trip only closes the file; without this the renderer's
  // `MediaRecorder` would keep capturing into nothing. Listeners are awaited
  // before the stream is finalized, so the trailing chunk still lands.
  recordingManager.onAutoStop(async ({ recordingId, paneId }) => {
    await stopRendererRecording(recordingId, paneId);
    flushChunkQueue(recordingId);
  });

  app.on("before-quit", () => {
    void recordingManager.stopAll();
  });
}
