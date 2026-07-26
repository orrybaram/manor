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
import { PICKER_SCRIPT } from "../picker-script";
import { WebviewServer } from "../webview-server";
import type { ProjectManager } from "../persistence";
import type { GitHubManager } from "../github";
import type { LinearManager } from "../linear";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { TaskManager } from "../task-persistence";
import type { LocalBackend } from "../backend/local-backend";
import type { IpcDeps } from "./types";
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

// Re-exported so ticket 3's HTTP routes can start/stop recordings without
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
 * ticket 3's `record/start` route.
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

export function createWebviewServer(
  projectManager?: ProjectManager,
  githubManager?: GitHubManager,
  linearManager?: LinearManager,
  layoutPersistence?: LayoutPersistence,
  taskManager?: TaskManager,
  backend?: LocalBackend,
): WebviewServer {
  return new WebviewServer(
    webviewRegistry,
    projectManager,
    githubManager,
    linearManager,
    layoutPersistence,
    taskManager,
    backend,
  );
}

// ── Recording (ADR-158) ──

/** Payload of the main→renderer "webview:recording-command" channel. */
interface RecordingCommand {
  cmd: "start" | "stop";
  recordingId: string;
  /** Chromium media source id of the pane's webview. Required for "start". */
  mediaSourceId?: string;
  /**
   * Pane this command is for. The renderer needs it to drive a per-pane
   * "Recording" indicator (ADR-158 ticket 5) — `sendRecordingCommand` already
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
 * is treated as success. Ticket 3's start route relies on this to roll back a
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
 * ticket 3's HTTP routes and the teardown paths should call.
 */
export async function stopRecording(recordingId: string, timeoutMs?: number) {
  const paneId = recordingManager
    .list()
    .find((r) => r.recordingId === recordingId)?.paneId;
  if (paneId) await stopRendererRecording(recordingId, paneId, timeoutMs);
  flushChunkQueue(recordingId);
  return recordingManager.stop(recordingId);
}

export function register(deps: IpcDeps): void {
  function getMainWindow() {
    return deps.mainWindow;
  }

  ipcMain.handle(
    "webview:register",
    (_event, paneId: string, webContentsId: number) => {
      assertString(paneId, "paneId");
      webviewRegistry.set(paneId, webContentsId);
      deps.webviewServer.attachConsoleListener(paneId);

      const rendererWebContents = _event.sender;
      paneRenderers.set(paneId, rendererWebContents.id);

      const wc = webContents.fromId(webContentsId);
      if (wc) {
        const handler = (
          _ev: Electron.Event,
          params: Electron.ContextMenuParams,
        ) => {
          const template: Electron.MenuItemConstructorOptions[] = [];

          if (params.mediaType === "image" && params.srcURL) {
            template.push(
              {
                label: "Open Image in New Tab",
                click: () => {
                  rendererWebContents.send(
                    "webview:new-window",
                    paneId,
                    params.srcURL,
                  );
                },
              },
              {
                label: "Save Image As...",
                click: async () => {
                  const win = BrowserWindow.fromWebContents(rendererWebContents);
                  if (!win) return;
                  const result = await dialog.showSaveDialog(win, {
                    defaultPath: new URL(params.srcURL).pathname
                      .split("/")
                      .pop() || "image",
                  });
                  if (!result.canceled && result.filePath) {
                    wc.downloadURL(params.srcURL);
                    wc.session.once("will-download", (_e, item) => {
                      item.setSavePath(result.filePath!);
                    });
                  }
                },
              },
              {
                label: "Copy Image",
                click: () => {
                  wc.copyImageAt(params.x, params.y);
                },
              },
              {
                label: "Copy Image Address",
                click: () => {
                  clipboard.writeText(params.srcURL);
                },
              },
              { type: "separator" },
            );
          }

          template.push({
            label: "Inspect Element",
            click: () => wc.inspectElement(params.x, params.y),
          });

          const menu = Menu.buildFromTemplate(template);
          menu.popup();
        };
        wc.on("context-menu", handler);
        webviewContextMenuCleanup.set(paneId, () => {
          wc.off("context-menu", handler);
        });

        let lastEscapeTime = 0;
        const escapeHandler = (
          ev: Electron.Event,
          input: Electron.Input,
        ) => {
          if (input.type !== "keyDown") return;

          // Escape — double-tap to blur webview
          if (
            input.key === "Escape" &&
            !input.alt &&
            !input.control &&
            !input.meta &&
            !input.shift
          ) {
            const now = Date.now();
            if (now - lastEscapeTime < 500) {
              ev.preventDefault();
              rendererWebContents.send("webview:escape", paneId);
              lastEscapeTime = 0;
            } else {
              lastEscapeTime = now;
            }
            return;
          }

          // Browser keybindings (Cmd only, no other modifiers)
          if (input.meta && !input.alt && !input.control && !input.shift) {
            if (input.key === "=") {
              ev.preventDefault();
              wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
            } else if (input.key === "-") {
              ev.preventDefault();
              wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
            } else if (input.key === "0") {
              ev.preventDefault();
              wc.setZoomLevel(0);
            } else if (input.key === "r") {
              ev.preventDefault();
              wc.reload();
            } else if (input.key === "l") {
              ev.preventDefault();
              rendererWebContents.send("webview:focus-url", paneId);
            } else if (input.key === "f") {
              ev.preventDefault();
              rendererWebContents.send("webview:find", paneId);
            } else if (input.key === "[") {
              ev.preventDefault();
              rendererWebContents.send("webview:go-back", paneId);
            } else if (input.key === "]") {
              ev.preventDefault();
              rendererWebContents.send("webview:go-forward", paneId);
            }
          }
        };
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
        //   verified empirically in-app; orchestrator/verifier should confirm
        //   via the Ticket 1 spike):
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
          return {
            action: "allow",
            overrideBrowserWindowOptions: buildPopupWindowOptions(
              getMainWindow(),
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
          const win = BrowserWindow.fromWebContents(wc.hostWebContents ?? wc);
          const choice = dialog.showMessageBoxSync(win ?? getMainWindow()!, {
            type: "question",
            buttons: ["Leave", "Stay"],
            defaultId: 1,
            cancelId: 1,
            title: "Leave site?",
            message: "Changes you made may not be saved.",
          });
          if (choice === 0) {
            event.preventDefault(); // allow navigation
          }
        };
        wc.on("will-prevent-unload", preventUnloadHandler);

        webviewUnloadCleanup.set(paneId, () => {
          wc.off("will-prevent-unload", preventUnloadHandler);
        });
      }
    },
  );

  ipcMain.handle("webview:unregister", (_event, paneId: string) => {
    assertString(paneId, "paneId");
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
    deps.webviewServer.detachConsoleListener(paneId);
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

  ipcMain.handle("webview:start-picker", async (event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;

    await wc.executeJavaScript(PICKER_SCRIPT);

    // Route the pane-scoped picker result back to the window that started the
    // picker (which owns the pane), not just the primary window — otherwise a
    // detached window's browser pane would never receive its result.
    const rendererWebContents = event.sender;
    const listener = (
      _ev: Electron.Event,
      _level: number,
      message: string,
    ) => {
      if (rendererWebContents.isDestroyed()) {
        wc.off("console-message", listener);
        return;
      }
      if (message.startsWith("__MANOR_PICK__:")) {
        wc.off("console-message", listener);
        try {
          const result = JSON.parse(
            message.slice("__MANOR_PICK__:".length),
          );
          rendererWebContents.send("webview:picker-result", paneId, result);
        } catch {
          // ignore parse errors
        }
      } else if (message === "__MANOR_PICK_CANCEL__") {
        wc.off("console-message", listener);
        rendererWebContents.send("webview:picker-cancel", paneId);
      }
    };

    wc.on("console-message", listener);
  });

  ipcMain.handle("webview:cancel-picker", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    await wc.executeJavaScript(
      "if (window.__manor_picker_cancel__) window.__manor_picker_cancel__();",
    );
  });

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

  // ── Recording (ADR-158) ──

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

  // The user clicked the pane's "Recording" indicator (ADR-158 ticket 5) — the
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
