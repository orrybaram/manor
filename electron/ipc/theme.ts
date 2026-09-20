import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import { publishRendererBroadcast } from "../renderer-broadcast";
import type { IpcDeps } from "./types";
import type { ThemeManager } from "../theme";

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

/**
 * Select a theme and tell every viewer.
 *
 * A theme change is every viewer's, not just the caller's: without the
 * fan-out a second desktop window and every browser on the bridge kept the
 * old theme until they next remounted (ADR-179 ticket 7). Lifted out of the
 * IPC handler so the `POST /theme` route (CLI, MCP) reaches the same viewers
 * the IPC path does — the route used to change the theme silently.
 *
 * The caller learns the new theme from the return value; these two cover
 * everybody else, the same split `preferences:set` uses — one sink for the
 * bridge, one channel for every other desktop window.
 */
export function themeSetSelected(
  deps: Pick<IpcDeps, "themeManager" | "getRendererWindows">,
  name: string,
): ReturnType<ThemeManager["getTheme"]> {
  deps.themeManager.setSelectedThemeName(name);
  const theme = deps.themeManager.getTheme();
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
}

export function register(deps: IpcDeps): void {
  ipcMain.handle("theme:get", () => themeGet(deps));

  ipcMain.handle("theme:setSelected", (_event, name: string) => {
    assertString(name, "name");
    return themeSetSelected(deps, name);
  });

  ipcMain.handle("theme:getSelectedName", () => themeGetSelectedName(deps));

  ipcMain.handle("theme:hasGhosttyConfig", () => themeHasGhosttyConfig(deps));

  ipcMain.handle("theme:preview", (_event, name: string) =>
    themePreview(deps, name),
  );

  ipcMain.handle("theme:allColors", () => themeAllColors(deps));
}
