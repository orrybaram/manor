import { assertString } from "../../ipc-validate";
import {
  connectionIdForWindow,
  publishRendererBroadcast,
  publishToRenderer,
} from "../../renderer-broadcast";
import type { DesktopDeps, ServerDeps } from "../../ipc/types";
import { isSharedPreferenceKey, type AppPreferences } from "../../preferences";
import { isPromptId, promptDefinition, promptProblems } from "../../../src/lib/prompts/catalog";
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
export function preferencesGetAll(ctx: HandlerCtx<ServerDeps>): AppPreferences {
  return ctx.deps.preferencesManager.getAll();
}

/**
 * A `full` device may write preferences — all but `remoteControlOnLaunch`,
 * which only `remoteControl.setStartOnLaunch` writes, and `promptOverrides`,
 * which only `preferencesSetPrompt` writes (`isSharedPreferenceKey`).
 */
export function preferencesSet<K extends keyof AppPreferences>(
  ctx: HandlerCtx<ServerDeps>,
  key: K,
  value: AppPreferences[K],
): void {
  assertString(key, "key");
  if (!isSharedPreferenceKey(key)) {
    throw new Error(`preferences.set cannot write '${key}'`);
  }
  ctx.deps.preferencesManager.set(key, value);
}

/**
 * Settings › Prompts saving one prompt; null, or its default text, goes back
 * to the default so a later change to that default reaches it. On the bridge
 * and not `POST /preferences`: Settings can reach it, an agent's CLI can't.
 */
export function preferencesSetPrompt(
  ctx: HandlerCtx<ServerDeps>,
  id: string,
  text: string | null,
): void {
  if (!isPromptId(id)) throw new Error(`preferences.setPrompt: unknown prompt '${String(id)}'`);
  if (text !== null) {
    assertString(text, "text");
    const problems = promptProblems(id, text);
    if (problems.empty) throw new Error(`preferences.setPrompt: '${id}' can't be blank`);
    if (problems.tooLong) throw new Error(`preferences.setPrompt: '${id}' is too long`);
  }
  const { [id]: _previous, ...others } = ctx.deps.preferencesManager.get("promptOverrides");
  const isDefault = text === null || text === promptDefinition(id).template;
  ctx.deps.preferencesManager.set("promptOverrides", isDefault ? others : { ...others, [id]: text });
}

/** Through the server's sound sink: a server with no speaker plays nothing. */
export function preferencesPlaySound(
  ctx: HandlerCtx<Pick<ServerDeps, "playSound">>,
  soundName: string,
): void {
  assertString(soundName, "soundName");
  ctx.deps.playSound?.(soundName);
}

export function keybindingsGetAll(
  ctx: HandlerCtx<ServerDeps>,
): Record<string, string> {
  return ctx.deps.keybindingsManager.getAll();
}

export function keybindingsSet(
  ctx: HandlerCtx<ServerDeps>,
  commandId: string,
  combo: string,
): void {
  assertString(commandId, "commandId");
  assertString(combo, "combo");
  ctx.deps.keybindingsManager.set(commandId, combo);
}

export function keybindingsReset(
  ctx: HandlerCtx<ServerDeps>,
  commandId: string,
): void {
  assertString(commandId, "commandId");
  ctx.deps.keybindingsManager.reset(commandId);
}

export function keybindingsResetAll(ctx: HandlerCtx<ServerDeps>): void {
  ctx.deps.keybindingsManager.resetAll();
}

/**
 * A popout pressed a primary-only shortcut (⌘, ⌘K, ⌘⇧N, …): bring the
 * primary window forward and run the command there.
 *
 * The command goes out as a `keybindings.forwardedCommand` event addressed to
 * the primary's connection; `App.tsx`'s `onForwardedCommand`
 * hears it the same way it hears one forwarded out of a `<webview>`
 * (`webview-keys.ts`).
 */
export function keybindingsRunInMainWindow(
  ctx: { deps: Pick<DesktopDeps, "mainWindow"> },
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
 * Every caller of `preferencesSet` shares it, table and route alike. Not
 * `register()`: this subscription has to run once, at boot, the same way
 * `wireStatsBroadcast` and `wireRemoteControlStatus` do for their namespaces.
 */
export function wirePreferencesBroadcast(
  deps: Pick<ServerDeps, "preferencesManager">,
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
  deps: Pick<ServerDeps, "keybindingsManager">,
): void {
  deps.keybindingsManager.onChange((overrides) => {
    publishRendererBroadcast("keybindings", "changed", overrides);
  });
}

export const preferences = {
  getAll: method(preferencesGetAll),
  // A `full` device may write preferences.
  set: method(preferencesSet, { mutating: true }),
  setPrompt: method(preferencesSetPrompt, { mutating: true }),
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
