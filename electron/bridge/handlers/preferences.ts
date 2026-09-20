import { assertString } from "../../ipc-validate";
import { playNotificationSound } from "../../notifications";
import {
  connectionIdForWindow,
  publishRendererBroadcast,
  publishToRenderer,
} from "../../renderer-broadcast";
import type { IpcDeps } from "../../ipc/types";
import {
  MAIN_WINDOW_KEYBINDINGS,
  type ForwardedCommandPayload,
} from "../../../src/lib/menu-commands";

/**
 * Preferences and keybindings, as plain functions over `IpcDeps` (ADR-180
 * ticket 7, relocated whole by ticket 11). There is no `register()` here any
 * more; the handler table (`electron/bridge/handlers.ts`) is the only caller
 * left. What used to sit beside these in `electron/ipc/misc.ts` — the dialog,
 * the shell escape hatches, the clipboard and the updater — is
 * `electron/ipc/native.ts` now, the half of that file only Electron can do.
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
    key as keyof import("../../preferences").AppPreferences,
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

/**
 * Wire the `preferences.changed` broadcast.
 *
 * `PreferencesManager.onChange` holds exactly one callback, so this is the
 * only place a preferences change can be observed — hence the bridge sink
 * here rather than a second subscription of its own. Every caller of
 * `preferencesSet` shares it, table and route alike. Not `register()`: this
 * subscription has to run once, at boot, the same way `wireStatsBroadcast`
 * and `wireRemoteControlStatus` do for their namespaces.
 */
export function wirePreferencesBroadcast(
  deps: Pick<IpcDeps, "preferencesManager">,
): void {
  deps.preferencesManager.onChange((prefs) => {
    publishRendererBroadcast("preferences", "changed", prefs);
  });
}

/**
 * Wire the `keybindings.changed` broadcast.
 *
 * Every window dispatches keybindings (popouts included), so every window
 * needs the edit — a broadcast, same as preferences above.
 */
export function wireKeybindingsBroadcast(
  deps: Pick<IpcDeps, "keybindingsManager">,
): void {
  deps.keybindingsManager.onChange((overrides) => {
    publishRendererBroadcast("keybindings", "changed", overrides);
  });
}
