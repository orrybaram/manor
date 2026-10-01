import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";

/**
 * The reads, lifted out of their `ipcMain.handle` wrappers so the ADR-178
 * WebSocket bridge calls the same code the desktop renderer does.
 * `theme:setSelected` stays desktop-only: it changes what *every* viewer of
 * this host sees, and there is no broadcast for it yet.
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
    return themeManager.getTheme();
  });

  ipcMain.handle("theme:getSelectedName", () => themeGetSelectedName(deps));

  ipcMain.handle("theme:hasGhosttyConfig", () => themeHasGhosttyConfig(deps));

  ipcMain.handle("theme:preview", (_event, name: string) =>
    themePreview(deps, name),
  );

  ipcMain.handle("theme:allColors", () => themeAllColors(deps));
}
