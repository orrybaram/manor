import { ipcMain, Menu, webContents, dialog, BrowserWindow } from "electron";
import { assertString } from "../ipc-validate";
import { PICKER_SCRIPT } from "../picker-script";
import { WebviewServer } from "../webview-server";
import type { IpcDeps } from "./types";

export const webviewRegistry = new Map<string, number>();

const webviewContextMenuCleanup = new Map<string, () => void>();
const webviewEscapeCleanup = new Map<string, () => void>();
const newWindowConsoleCleanup = new Map<string, () => void>();
const webviewEventCleanup = new Map<string, () => void>();

const INTERCEPT_NEW_WINDOW_SCRIPT = `
(function() {
  if (window.__manor_intercept_new_window__) return;
  window.__manor_intercept_new_window__ = true;
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    if (el.getAttribute('target') === '_blank' && el.href) {
      e.preventDefault();
      e.stopPropagation();
      console.log('__manor_new_window__:' + el.href);
    }
  }, true);
  window.open = function(url) {
    if (url) console.log('__manor_new_window__:' + url);
    return null;
  };
})();
`;

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
          const menu = Menu.buildFromTemplate([
            {
              label: "Inspect Element",
              click: () => wc.inspectElement(params.x, params.y),
            },
          ]);
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

        webviewEventCleanup.set(paneId, () => {
          wc.off("did-start-loading", loadingStartHandler);
          wc.off("did-stop-loading", loadingStopHandler);
          wc.off("page-favicon-updated", faviconHandler);
          wc.off("found-in-page", findResultHandler);
        });

        // Intercept target="_blank" clicks and window.open() inside the guest page.
        const injectNewWindowIntercept = () => {
          if (wc.isDestroyed()) return;
          wc.executeJavaScript(INTERCEPT_NEW_WINDOW_SCRIPT).catch(() => {});
        };
        wc.on("did-finish-load", injectNewWindowIntercept);

        const newWindowListener = (
          _ev: Electron.Event,
          _level: number,
          message: string,
        ) => {
          if (message.startsWith("__manor_new_window__:")) {
            const url = message.slice("__manor_new_window__:".length);
            rendererWebContents.send("webview:new-window", paneId, url);
          }
        };
        wc.on("console-message", newWindowListener);

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

        newWindowConsoleCleanup.set(paneId, () => {
          wc.off("did-finish-load", injectNewWindowIntercept);
          wc.off("console-message", newWindowListener);
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
    newWindowConsoleCleanup.get(paneId)?.();
    newWindowConsoleCleanup.delete(paneId);
    webviewEventCleanup.get(paneId)?.();
    webviewEventCleanup.delete(paneId);
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
}
