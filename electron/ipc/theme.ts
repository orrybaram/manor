import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { themeManager } = deps;

  ipcMain.handle("theme:get", () => {
    return themeManager.getTheme();
  });

  ipcMain.handle("theme:setSelected", (_event, name: string) => {
    assertString(name, "name");
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
    assertString(name, "name");
    return themeManager.getThemeByName(name);
  });

  ipcMain.handle("theme:allColors", async () => {
    return themeManager.loadAllThemeColors();
  });
}
