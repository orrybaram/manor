---
title: Menu controller, menu IPC channels, preload API, and app-lifecycle wiring
status: done
priority: critical
assignee: sonnet
blocked_by: [2]
---

# Menu controller and IPC wiring

Install the menu built by ticket 2, keep it fresh, and route clicks to the right renderer window. Read `index.md` › Architecture › 4 and 5.

## Steps

1. Create `electron/app-menu.ts`:
   ```ts
   export interface AppMenuDeps {
     getMainWindow: () => BrowserWindow | null;
     getRendererWindows: () => BrowserWindow[];
     keybindingsManager: KeybindingsManager;
     checkForUpdates: () => void;
     saveZoomLevel: (factor: number) => void;
   }
   export interface AppMenuController {
     setContext(context: MenuContext): void;
     rebuild(): void;
     dispose(): void;
   }
   export function installAppMenu(deps: AppMenuDeps): AppMenuController;
   ```
   - State: `context: MenuContext | null`, `bindings` from `resolveBindings(keybindingsManager.getAll(), process.platform === "darwin" ? "MacIntel" : "other").bindings` (recomputed on change), `platform` = `"mac"` on darwin else `"other"`.
   - `rebuild()` calls `buildMenuTemplate(state, actions)` → `Menu.buildFromTemplate` → `Menu.setApplicationMenu`. Public `rebuild` is immediate; internal triggers go through a 50 ms trailing debounce (`scheduleRebuild`).
   - Triggers: `keybindingsManager.onChange(...)` (keep the unsubscribe for `dispose`), `setContext` (store, then schedule), and `app.on("browser-window-focus", scheduleRebuild)`.
   - `actions.send(commandId, args)`: pick the target window. `const focused = BrowserWindow.getFocusedWindow()`; if `focused` is in `getRendererWindows()`, is not the main window, and `SHARED_WINDOW_COMMANDS.has(commandId)`, target it; otherwise target `getMainWindow()`. If the target is null or destroyed, no-op. Send `"menu-command"` with a `MenuCommandPayload`.
   - `actions.zoom(delta | "reset")`: apply to the focused renderer window (fallback main): `setZoomFactor(1)` for reset, else clamp `current + delta` to `[0.3, 3]`. Call `saveZoomLevel` only when the target is the main window (detached windows do not persist zoom; see `electron/window.ts:154-163`).
   - `actions.checkForUpdates` → deps; `actions.openExternal(url)` → `shell.openExternal(url)`; `actions.revealDataFolder` → `shell.showItemInFolder(manorDataDir())` from `./paths`.
   - Export a small pure helper `pickTargetWindow(commandId, focused, main, rendererWindows)` and test it.
2. Create `electron/ipc/menu.ts` following the shape of the other `electron/ipc/*.ts` modules (`register(deps)`): handle `ipcMain.on("menu:setContext", (event, context) => ...)`. Accept only when `BrowserWindow.fromWebContents(event.sender) === deps.mainWindow`; validate that `context` is a non-null object (reuse `electron/ipc-validate.ts` helpers if one fits) and forward to `deps.appMenu.setContext(context)`. Add `appMenu: AppMenuController` to `IpcDeps` in `electron/ipc/types.ts`.
3. `electron/ipc/misc.ts`: add `ipcMain.handle("shell:showItemInFolder", (_e, p: string) => { assertString(p, "path"); shell.showItemInFolder(p); })`.
4. `electron/preload.ts`: add a `menu` namespace: `setContext(context) => ipcRenderer.send("menu:setContext", context)` and `onMenuCommand(cb) => onChannel("menu-command", cb)` (follow how `onAppCommand` unsubscribes). Add `shell.showItemInFolder(path)`. Mirror both in `src/electron.d.ts` using `MenuContext` / `MenuCommandPayload` types imported with `import type` from `src/lib/menu-commands`.
5. `electron/app-lifecycle.ts`: delete the inline template (lines ~423-499) and the now-unused `Menu` import. Before the IPC modules are registered, call `const appMenu = installAppMenu({ getMainWindow: () => mainWindow, getRendererWindows, keybindingsManager, checkForUpdates, saveZoomLevel })` and put `appMenu` in `ipcDeps`; register `menuIpc.register(ipcDeps)` alongside the others. `installAppMenu` must run after `app.whenReady()` (move the call into the `whenReady` block, before `openPrimaryWindow()`), but `ipcDeps.appMenu` may be a getter that reads a `let appMenu` variable so the IPC modules can be registered earlier as they are now.
6. Tests: `electron/app-menu.test.ts` for `pickTargetWindow` (shared command + focused detached → detached; primary-only command + focused detached → main; focused not a renderer window → main; no main → null). Mock `electron` the way `electron/__tests__/agents-getactive.test.ts` does if you need to import the module.
7. Manual smoke: `pnpm dev`, confirm the menu bar shows the nine menus, Settings… shows ⌘, and pressing ⌘, still opens settings (renderer dispatch), rebinding New Agent in Settings › Keybindings updates the File menu live, and View › Zoom In zooms. Menu clicks will not do anything in the renderer yet (ticket 4), that is expected.
8. Run both `tsc` configs, `npx vitest run electron`, `pnpm lint` on touched files.

## Files to touch
- `electron/app-menu.ts` — new controller
- `electron/app-menu.test.ts` — new
- `electron/ipc/menu.ts` — new, `menu:setContext`
- `electron/ipc/types.ts` — `appMenu` dep
- `electron/ipc/misc.ts` — `shell:showItemInFolder`
- `electron/preload.ts` — `menu` namespace, `shell.showItemInFolder`
- `src/electron.d.ts` — types for the above
- `electron/app-lifecycle.ts` — replace inline menu with `installAppMenu`, register menu IPC
