import { assertString } from "../../ipc-validate";
import { playNotificationSound } from "../../notifications";
import {
  connectionIdForWindow,
  publishRendererBroadcast,
  publishToRenderer,
} from "../../renderer-broadcast";
import type { HostDeps } from "../../ipc/types";
import type { AppPreferences } from "../../preferences";
import { method, type HandlerCtx } from "../method";
import {
  MAIN_WINDOW_KEYBINDINGS,
  type ForwardedCommandPayload,
} from "../../../src/lib/menu-commands";

/**
 * Preferences and keybindings, as the `preferences` and
 * `keybindings` namespaces of the handler table. The dialog, the shell escape
 * hatches, the clipboard and the updater are `electron/ipc/native.ts` — what
 * only Electron can do.
 */
export function preferencesGetAll(ctx: HandlerCtx): AppPreferences {
  return ctx.deps.preferencesManager.getAll();
}

/** A `full` device may write preferences (D3). */
export function preferencesSet<K extends keyof AppPreferences>(
  ctx: HandlerCtx,
  key: K,
  value: AppPreferences[K],
): void {
  assertString(key, "key");
  ctx.deps.preferencesManager.set(key, value);
}

export function preferencesPlaySound(_ctx: HandlerCtx, soundName: string): void {
  assertString(soundName, "soundName");
  playNotificationSound(soundName);
}

export function keybindingsGetAll(ctx: HandlerCtx): Record<string, string> {
  return ctx.deps.keybindingsManager.getAll();
}

export function keybindingsSet(
  ctx: HandlerCtx,
  commandId: string,
  combo: string,
): void {
  assertString(commandId, "commandId");
  assertString(combo, "combo");
  ctx.deps.keybindingsManager.set(commandId, combo);
}

export function keybindingsReset(ctx: HandlerCtx, commandId: string): void {
  assertString(commandId, "commandId");
  ctx.deps.keybindingsManager.reset(commandId);
}

export function keybindingsResetAll(ctx: HandlerCtx): void {
  ctx.deps.keybindingsManager.resetAll();
}

/**
 * A popout pressed a primary-only shortcut (⌘, ⌘K, ⌘⇧N, …): bring the
 * primary window forward and run the command there (ADR-175).
 *
 * The command goes out as a `keybindings.forwardedCommand` event addressed to
 * the primary's connection (ADR-180 D5); `App.tsx`'s `onForwardedCommand`
 * hears it the same way it hears one forwarded out of a `<webview>`
 * (`webview-keys.ts`).
 */
export function keybindingsRunInMainWindow(
  ctx: { deps: Pick<HostDeps, "mainWindow"> },
  commandId: string,
): void {
  assertString(commandId, "commandId");
  if (!MAIN_WINDOW_KEYBINDINGS.has(commandId)) return;
  const mw = ctx.deps.mainWindow;
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
  deps: Pick<HostDeps, "preferencesManager">,
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
  deps: Pick<HostDeps, "keybindingsManager">,
): void {
  deps.keybindingsManager.onChange((overrides) => {
    publishRendererBroadcast("keybindings", "changed", overrides);
  });
}

export const preferences = {
  getAll: method(preferencesGetAll),
  // A `full` device may write preferences (D3).
  set: method(preferencesSet, { mutating: true }),
  playSound: method(preferencesPlaySound),
};

export const keybindings = {
  getAll: method(keybindingsGetAll),
  // The keybindings page is read-only on web: a device is refused an edit
  // the settings UI never offered it.
  set: method(keybindingsSet, { localOnly: true }),
  reset: method(keybindingsReset, { localOnly: true }),
  resetAll: method(keybindingsResetAll, { localOnly: true }),
  // Names a window; a device has none of its own to run a command in.
  runInMainWindow: method(keybindingsRunInMainWindow, { localOnly: true }),
};
