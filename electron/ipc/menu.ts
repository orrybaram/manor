import { BrowserWindow, ipcMain } from "electron";
import type { MenuContext } from "../../src/lib/menu-commands";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  // Only the primary window's context matters to the menu (ADR-170 §5): a
  // detached window has no menu-relevant chrome of its own.
  ipcMain.on("menu:setContext", (event, context: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== deps.mainWindow) return;
    if (typeof context !== "object" || context === null) return;
    deps.appMenu.setContext(context as MenuContext);
  });
}
