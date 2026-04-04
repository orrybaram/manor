import { ipcMain } from "electron";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { themeManager } = deps;

  ipcMain.handle("theme:get", () => {
    return themeManager.getTheme();
  });

  ipcMain.handle("theme:setSelected", (_event, name: string) => {
    themeManager.setSelectedThemeName(name);
    return themeManager.getTheme();
  });

  ipcMain.handle("theme:getSelectedName", () => {
    return themeManager.getSelectedThemeName();
  });

  ipcMain.handle("theme:hasGhosttyConfig", () => {
    return themeManager.hasGhosttyConfig();
  });

  ipcMain.handle("theme:preview", (_event, name: string) => {
    return themeManager.getThemeByName(name);
  });

  ipcMain.handle("theme:allColors", async () => {
    return themeManager.loadAllThemeColors();
  });
}
