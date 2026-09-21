import { BrowserWindow, ipcMain, dialog, shell, clipboard } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertString } from "../ipc-validate";
import { checkForUpdates, quitAndInstall } from "../updater";
import { openInEditor } from "../editor";
import type { IpcDeps } from "./types";

/**
 * The native dialog, the shell escape hatches, the clipboard and the
 * updater (ADR-180 D8) — four of the six things `electron/ipc/` keeps for
 * good, alongside `webview.ts`/`webview-keys.ts`, `window.ts`, `popups.ts`
 * and `menu.ts`. What used to sit beside these in this file — preferences and
 * keybindings — crossed to the handler table in ADR-180 ticket 7 and their
 * lifted bodies live in `electron/bridge/handlers/preferences.ts` now.
 *
 * There is no lifted-function half here to move: every one of these is a
 * real `ipcMain.handle`, and stays one, because none of it can be answered
 * anywhere but Electron's main process — a directory picker, `shell.
 * openExternal`, the OS clipboard, `autoUpdater`. A paired `full` device gets
 * `unavailable:web` for all of it, which is what `src/bridge/unavailable.ts`
 * names as a design fact rather than a gap.
 */
export function register(deps: IpcDeps): void {
  const { backend, preferencesManager } = deps;

  function getMainWindow() {
    return deps.mainWindow;
  }

  // ── Dialog ──
  ipcMain.handle("dialog:openDirectory", async (event) => {
    // Attach the sheet to the window that asked — a popout gets its own dialog
    // instead of one hung off the main window. Falls through to a parentless
    // dialog rather than a destroyed one when neither window is alive.
    const owner =
      BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory"],
    };
    const result =
      owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ── Updater ──
  ipcMain.handle("updater:checkForUpdates", () => checkForUpdates());
  ipcMain.handle("updater:quitAndInstall", () => quitAndInstall());

  // ── Shell ──
  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    assertString(url, "url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid URL format");
    }
    const allowed = ["https:", "http:", "file:", "x-apple.systempreferences:"];
    if (!allowed.includes(parsed.protocol)) {
      throw new Error(`Blocked protocol: ${parsed.protocol}`);
    }
    return shell.openExternal(url);
  });

  ipcMain.handle("shell:showItemInFolder", (_event, p: string) => {
    assertString(p, "path");
    shell.showItemInFolder(p);
  });

  ipcMain.handle("shell:openInEditor", async (_event, dirPath: string) => {
    assertString(dirPath, "dirPath");
    return openInEditor(preferencesManager, dirPath);
  });

  ipcMain.handle(
    "shell:resolveFilePath",
    async (_event, filePath: string, cwd: string): Promise<string | null> => {
      assertString(filePath, "filePath");
      assertString(cwd, "cwd");
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(cwd, filePath);
      try {
        const stat = await fs.promises.stat(resolved);
        return stat.isFile() ? resolved : null;
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(
    "shell:discoverAgents",
    async (): Promise<Array<{ name: string; command: string }>> => {
      const agents = [
        {
          name: "Claude Code",
          bin: "claude",
          command: "claude --dangerously-skip-permissions",
        },
        { name: "Codex", bin: "codex", command: "codex --yolo" },
        { name: "OpenCode", bin: "opencode", command: "opencode" },
      ];
      const found: Array<{ name: string; command: string }> = [];
      await Promise.all(
        agents.map(async (agent) => {
          const result = await backend.shell.which(agent.bin);
          if (result !== null)
            found.push({ name: agent.name, command: agent.command });
        }),
      );
      return found;
    },
  );

  // ── Clipboard ──
  ipcMain.handle("clipboard:writeText", (_event, text: string) => {
    clipboard.writeText(text);
  });
}
