import {
  ipcMain,
  Menu,
  webContents,
  dialog,
  BrowserWindow,
  clipboard,
  nativeImage,
  shell,
} from "electron";
import { assertString } from "../ipc-validate";
import { PICKER_SCRIPT } from "../picker-script";
import { WebviewServer } from "../webview-server";
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

const webviewContextMenuCleanup = new Map<string, () => void>();
const webviewEscapeCleanup = new Map<string, () => void>();
const webviewUnloadCleanup = new Map<string, () => void>();
const webviewEventCleanup = new Map<string, () => void>();
const webviewAudioCleanup = new Map<string, () => void>();
const webviewPopupCleanup = new Map<string, () => void>();

export function createWebviewServer(): WebviewServer {
  return new WebviewServer(webviewRegistry);
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
  });

  ipcMain.handle("webview:start-picker", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    const webContentsId = webviewRegistry.get(paneId);
    if (!webContentsId) return;
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;

    await wc.executeJavaScript(PICKER_SCRIPT);

    const listener = (
      _ev: Electron.Event,
      _level: number,
      message: string,
    ) => {
      const mw = getMainWindow();
      if (
        mw &&
        !mw.isDestroyed() &&
        !mw.webContents.isDestroyed()
      ) {
        if (message.startsWith("__MANOR_PICK__:")) {
          wc.off("console-message", listener);
          try {
            const result = JSON.parse(
              message.slice("__MANOR_PICK__:".length),
            );
            mw.webContents.send("webview:picker-result", paneId, result);
          } catch {
            // ignore parse errors
          }
        } else if (message === "__MANOR_PICK_CANCEL__") {
          wc.off("console-message", listener);
          mw.webContents.send("webview:picker-cancel", paneId);
        }
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
}
