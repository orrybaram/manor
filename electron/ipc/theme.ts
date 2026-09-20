import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import { publishRendererBroadcast } from "../renderer-broadcast";
import type { IpcDeps } from "./types";

/**
 * The reads, lifted out of their `ipcMain.handle` wrappers so the ADR-178
 * WebSocket bridge calls the same code the desktop renderer does.
 */
export function themeGet(deps: IpcDeps): unknown {
  return deps.themeManager.getTheme();
}

export function themeGetSelectedName(deps: IpcDeps): string {
  return deps.themeManager.getSelectedThemeName();
}

export function themeHasGhosttyConfig(deps: IpcDeps): boolean {
  return deps.themeManager.hasGhosttyConfig();
}

export function themePreview(deps: IpcDeps, name: string): unknown {
  assertString(name, "name");
  return deps.themeManager.getThemeByName(name);
}

export function themeAllColors(deps: IpcDeps): Promise<unknown> {
  return deps.themeManager.loadAllThemeColors();
}

export function register(deps: IpcDeps): void {
  const { themeManager } = deps;

  ipcMain.handle("theme:get", () => themeGet(deps));

  ipcMain.handle("theme:setSelected", (_event, name: string) => {
    assertString(name, "name");
    themeManager.setSelectedThemeName(name);
    const theme = themeManager.getTheme();
    // A theme change is every viewer's, not just the window that asked
    // (ADR-179 ticket 7's report): without this, a second desktop window and
    // every browser on the bridge kept the old theme until they next
    // remounted. `setSelected`'s own return value covers the caller; these two
    // cover everybody else, the same split `preferences:set` uses — one sink
    // for the bridge, one channel for every other desktop window.
    publishRendererBroadcast("theme", "changed", { name, theme });
    for (const win of deps.getRendererWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        win.webContents.send("theme:changed", { name, theme });
      } catch {
        // A torn-down webContents mid-send is not worth crashing over.
      }
    }
    return theme;
  });

  ipcMain.handle("theme:getSelectedName", () => themeGetSelectedName(deps));

  ipcMain.handle("theme:hasGhosttyConfig", () => themeHasGhosttyConfig(deps));

  ipcMain.handle("theme:preview", (_event, name: string) =>
    themePreview(deps, name),
  );

  ipcMain.handle("theme:allColors", () => themeAllColors(deps));
}
