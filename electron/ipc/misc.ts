import { BrowserWindow, ipcMain, dialog, shell, clipboard } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertString } from "../ipc-validate";
import { playNotificationSound, showPrNotification } from "../notifications";
import { checkForUpdates, quitAndInstall } from "../updater";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { backend, preferencesManager, keybindingsManager } = deps;

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

  ipcMain.handle("shell:openInEditor", async (_event, dirPath: string) => {
    assertString(dirPath, "dirPath");
    const editor = preferencesManager.get("defaultEditor");
    if (!editor) {
      return shell.openPath(dirPath);
    }
    return new Promise<string>((resolve) => {
      execFile(editor, [dirPath], (err) => {
        resolve(err ? err.message : "");
      });
    });
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
        { name: "Claude Code", bin: "claude", command: "claude --dangerously-skip-permissions" },
        { name: "Codex", bin: "codex", command: "codex --yolo" },
        { name: "OpenCode", bin: "opencode", command: "opencode" },
      ];
      const found: Array<{ name: string; command: string }> = [];
      await Promise.all(
        agents.map(async (agent) => {
          const result = await backend.shell.which(agent.bin);
          if (result !== null) found.push({ name: agent.name, command: agent.command });
        }),
      );
      return found;
    },
  );

  // ── Clipboard ──
  ipcMain.handle("clipboard:writeText", (_event, text: string) => {
    clipboard.writeText(text);
  });

  // ── Preferences ──
  ipcMain.handle("preferences:getAll", () => {
    return preferencesManager.getAll();
  });

  ipcMain.handle("preferences:set", (_event, key: string, value: unknown) => {
    assertString(key, "key");
    preferencesManager.set(
      key as keyof import("../preferences").AppPreferences,
      value as never,
    );
  });

  ipcMain.handle("preferences:playSound", (_event, soundName: string) => {
    playNotificationSound(soundName);
  });

  // ── Notifications ──
  /**
   * Returns whether a native notification was presented. `false` means the
   * calling window is focused, so the renderer should show an in-app toast
   * instead — the renderer must not make that call itself, see
   * `presentNotification`.
   */
  ipcMain.handle(
    "notifications:show",
    (event, payload: { title: string; body: string; url?: string }): boolean => {
      assertString(payload.title, "title");
      assertString(payload.body, "body");
      // Focus is judged against the window that asked, not the primary one:
      // the poller may live in a detached window (ADR-156).
      const callerWindow =
        BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
      return showPrNotification(payload, callerWindow, preferencesManager);
    },
  );

  preferencesManager.onChange((prefs) => {
    const mw = getMainWindow();
    if (
      mw &&
      !mw.isDestroyed() &&
      !mw.webContents.isDestroyed()
    ) {
      try {
        mw.webContents.send("preferences-changed", prefs);
      } catch {
        // Render frame disposed — safe to ignore
      }
    }
  });

  // ── Keybindings ──
  ipcMain.handle("keybindings:getAll", () => {
    return keybindingsManager.getAll();
  });

  ipcMain.handle(
    "keybindings:set",
    (_event, commandId: string, combo: string) => {
      assertString(commandId, "commandId");
      assertString(combo, "combo");
      keybindingsManager.set(commandId, combo);
    },
  );

  ipcMain.handle("keybindings:reset", (_event, commandId: string) => {
    assertString(commandId, "commandId");
    keybindingsManager.reset(commandId);
  });

  ipcMain.handle("keybindings:resetAll", () => {
    keybindingsManager.resetAll();
  });

  keybindingsManager.onChange((overrides) => {
    const mw = getMainWindow();
    if (
      mw &&
      !mw.isDestroyed() &&
      !mw.webContents.isDestroyed()
    ) {
      try {
        mw.webContents.send("keybindings-changed", overrides);
      } catch {
        // Render frame disposed — safe to ignore
      }
    }
  });
}
