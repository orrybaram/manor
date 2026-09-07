/**
 * The native application menu controller (ADR-170 §4).
 *
 * `installAppMenu` builds the menu from `buildMenuTemplate`, installs it with
 * `Menu.setApplicationMenu`, and keeps it fresh: a keybinding override, a
 * context push from the primary renderer, or a window focus change all
 * schedule a debounced rebuild (rebuilding while a menu is open closes it on
 * macOS, so bursts of these are coalesced). It also owns the runtime side of
 * `MenuActions`: routing a click to the right renderer window, applying zoom
 * to the focused window, and the handful of actions implemented in main
 * (check for updates, open external links, reveal the data folder).
 */

import { app, BrowserWindow, Menu, shell } from "electron";
import { resolveBindings, type KeyCombo } from "../src/lib/keybinding-defs";
import {
  SHARED_WINDOW_COMMANDS,
  type MenuCommandPayload,
  type MenuContext,
} from "../src/lib/menu-commands";
import {
  buildMenuTemplate,
  type MenuActions,
  type MenuTemplateState,
} from "./app-menu-template";
import type { KeybindingsManager } from "./keybindings";
import { manorDataDir } from "./paths";

export interface AppMenuDeps {
  getMainWindow: () => BrowserWindow | null;
  getRendererWindows: () => BrowserWindow[];
  keybindingsManager: KeybindingsManager;
  checkForUpdates: () => void;
  saveZoomLevel: (factor: number) => void;
}

export interface AppMenuController {
  setContext(context: MenuContext): void;
  /** Immediate rebuild; internal triggers go through a debounce instead. */
  rebuild(): void;
  dispose(): void;
}

const REBUILD_DEBOUNCE_MS = 50;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

function isLive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
}

/**
 * Picks the window a menu command should be sent to. Pure and exported for
 * testing: `actions.send` is the only runtime caller.
 *
 * - A shared-window command (one `createSharedKeybindingHandlers` implements)
 *   goes to the focused window when that window is a tracked renderer window
 *   other than the primary one — e.g. a detached window services its own
 *   "New Tab".
 * - Everything else, and any shared command when the focused window isn't a
 *   tracked detached window, goes to the primary window.
 */
export function pickTargetWindow(
  commandId: string,
  focused: BrowserWindow | null,
  main: BrowserWindow | null,
  rendererWindows: BrowserWindow[],
): BrowserWindow | null {
  if (
    focused &&
    focused !== main &&
    rendererWindows.includes(focused) &&
    SHARED_WINDOW_COMMANDS.has(commandId)
  ) {
    return focused;
  }
  return main;
}

export function installAppMenu(deps: AppMenuDeps): AppMenuController {
  const platform: "mac" | "other" =
    process.platform === "darwin" ? "mac" : "other";
  const keybindingPlatform =
    process.platform === "darwin" ? "MacIntel" : "other";

  let context: MenuContext | null = null;
  let bindings: Record<string, KeyCombo> = resolveBindings(
    deps.keybindingsManager.getAll(),
    keybindingPlatform,
  ).bindings;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  const actions: MenuActions = {
    send(commandId, args) {
      const focused = BrowserWindow.getFocusedWindow();
      const main = deps.getMainWindow();
      const target = pickTargetWindow(
        commandId,
        focused,
        main,
        deps.getRendererWindows(),
      );
      if (!isLive(target)) return;
      const payload: MenuCommandPayload = { commandId, args };
      target.webContents.send("menu-command", payload);
    },
    zoom(delta) {
      const focused = BrowserWindow.getFocusedWindow();
      const main = deps.getMainWindow();
      const target =
        isLive(focused) && deps.getRendererWindows().includes(focused)
          ? focused
          : main;
      if (!isLive(target)) return;
      const next =
        delta === "reset"
          ? 1
          : Math.min(
              MAX_ZOOM,
              Math.max(MIN_ZOOM, target.webContents.getZoomFactor() + delta),
            );
      target.webContents.setZoomFactor(next);
      // Detached windows are session-only; only the primary window persists zoom.
      if (target === main) {
        deps.saveZoomLevel(next);
      }
    },
    checkForUpdates() {
      deps.checkForUpdates();
    },
    openExternal(url) {
      shell.openExternal(url);
    },
    revealDataFolder() {
      shell.showItemInFolder(manorDataDir());
    },
  };

  function rebuild(): void {
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
    const state: MenuTemplateState = {
      context,
      bindings,
      isPackaged: app.isPackaged,
      platform,
      appName: app.name,
    };
    const menu = Menu.buildFromTemplate(buildMenuTemplate(state, actions));
    Menu.setApplicationMenu(menu);
  }

  function scheduleRebuild(): void {
    if (rebuildTimer !== null) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  rebuild();

  const unsubscribeKeybindings = deps.keybindingsManager.onChange(
    (overrides) => {
      bindings = resolveBindings(overrides, keybindingPlatform).bindings;
      scheduleRebuild();
    },
  );

  const onWindowFocus = (): void => scheduleRebuild();
  app.on("browser-window-focus", onWindowFocus);

  return {
    setContext(next) {
      context = next;
      scheduleRebuild();
    },
    rebuild,
    dispose() {
      unsubscribeKeybindings();
      app.off("browser-window-focus", onWindowFocus);
      if (rebuildTimer !== null) {
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
      }
    },
  };
}
