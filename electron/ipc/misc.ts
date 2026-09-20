import { BrowserWindow, ipcMain, dialog, shell, clipboard } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertString } from "../ipc-validate";
import { checkForUpdates, quitAndInstall } from "../updater";
import { openInEditor } from "../editor";
import { playNotificationSound } from "../notifications";
import {
  connectionIdForWindow,
  publishRendererBroadcast,
  publishToRenderer,
} from "../renderer-broadcast";
import type { IpcDeps } from "./types";
import {
  MAIN_WINDOW_KEYBINDINGS,
  type ForwardedCommandPayload,
} from "../../src/lib/menu-commands";

/**
 * Preferences and keybindings, lifted out of their `ipcMain.handle` wrappers
 * so the handler table calls the same code the desktop renderer does
 * (ADR-180 ticket 7). What is left of `register()` below is the half of this
 * file only Electron can do — the dialog, the shell escape hatches, the
 * clipboard and the updater — which is what `electron/ipc/` means from here
 * on (ADR-180 D8).
 */
export function preferencesGetAll(deps: IpcDeps): unknown {
  return deps.preferencesManager.getAll();
}

/**
 * A `full` device may write preferences (D3); this was off the slice-1 table
 * for scope, not policy.
 */
export function preferencesSet(
  deps: IpcDeps,
  key: string,
  value: unknown,
): void {
  assertString(key, "key");
  deps.preferencesManager.set(
    key as keyof import("../preferences").AppPreferences,
    value as never,
  );
}

/** Takes `_deps` only to match every other entry's `(deps, ...args)` shape. */
export function preferencesPlaySound(_deps: IpcDeps, soundName: string): void {
  assertString(soundName, "soundName");
  playNotificationSound(soundName);
}

export function keybindingsGetAll(deps: IpcDeps): Record<string, string> {
  return deps.keybindingsManager.getAll();
}

/**
 * `keybindings.set`/`reset`/`resetAll` are `LOCAL_ONLY` on the table — ticket
 * 6 made that page read-only on web, and this is where that decision lives
 * as code (ADR-180 D4). They still cross to the table rather than staying an
 * `ipcMain.handle`, because a desktop window reaches them the same way it
 * reaches everything else now.
 */
export function keybindingsSet(
  deps: IpcDeps,
  commandId: string,
  combo: string,
): void {
  assertString(commandId, "commandId");
  assertString(combo, "combo");
  deps.keybindingsManager.set(commandId, combo);
}

export function keybindingsReset(deps: IpcDeps, commandId: string): void {
  assertString(commandId, "commandId");
  deps.keybindingsManager.reset(commandId);
}

export function keybindingsResetAll(deps: IpcDeps): void {
  deps.keybindingsManager.resetAll();
}

/**
 * A popout pressed a primary-only shortcut (⌘, ⌘K, ⌘⇧N, …): bring the
 * primary window forward and run the command there (ADR-175).
 *
 * `LOCAL_ONLY` (D4) — it names a window, and a paired device has none of its
 * own to run a command in. What was `mw.webContents.send("keybinding-command",
 * …)` is a `keybindings.forwardedCommand` event addressed to the primary's
 * connection now (ADR-180 D5); `App.tsx`'s `onForwardedCommand` hears it the
 * same way it hears one forwarded out of a `<webview>` (`webview-keys.ts`).
 */
export function keybindingsRunInMainWindow(
  deps: Pick<IpcDeps, "mainWindow">,
  commandId: string,
): void {
  assertString(commandId, "commandId");
  if (!MAIN_WINDOW_KEYBINDINGS.has(commandId)) return;
  const mw = deps.mainWindow;
  if (!mw || mw.isDestroyed() || mw.webContents.isDestroyed()) return;
  if (mw.isMinimized()) mw.restore();
  mw.focus();
  const to = connectionIdForWindow(mw);
  if (to === null) return;
  const payload: ForwardedCommandPayload = { commandId, source: "popout" };
  publishToRenderer(to, "keybindings", "forwardedCommand", payload);
}

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

  // `PreferencesManager.onChange` holds exactly one callback, so this is the
  // only place a preferences change can be observed — hence the bridge sink
  // here rather than a second subscription of its own. Every caller of
  // `preferencesSet` shares it, table and route alike (ADR-180 ticket 7
  // dropped the `webContents.send` that used to run beside it).
  preferencesManager.onChange((prefs) => {
    publishRendererBroadcast("preferences", "changed", prefs);
  });

  // Every window dispatches keybindings (popouts included), so every window
  // needs the edit — a broadcast, same as preferences above.
  keybindingsManager.onChange((overrides) => {
    publishRendererBroadcast("keybindings", "changed", overrides);
  });
}
