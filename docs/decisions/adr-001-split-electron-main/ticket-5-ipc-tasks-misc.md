---
title: Extract tasks and misc IPC handlers
status: todo
priority: high
assignee: sonnet
blocked_by: [4]
---

# Extract tasks and misc IPC handlers

## 1. `electron/ipc/tasks.ts`

Move from `electron/main.ts` (lines 935–994):
- All 6 `tasks:*` handlers
- `paneContextMap` state (lines 247–250) — used by `tasks:setPaneContext` and `tasks:getAll`
- These handlers use `taskManager`, `paneContextMap`, and the unseen task sets from notifications module

Note: `tasks:markSeen` modifies `unseenRespondedTasks`/`unseenInputTasks` and calls `updateDockBadge()`. Import these from `../notifications.ts`.

Export: `export function register(deps: IpcDeps): void`

## 2. `electron/ipc/misc.ts`

Move remaining small handler groups from `electron/main.ts`:

**Dialog (line 867):**
- `dialog:openDirectory` — uses `dialog.showOpenDialog()`, `getMainWindow()`

**Updater (lines 876–877):**
- `updater:checkForUpdates` — calls `checkForUpdates()`
- `updater:quitAndInstall` — calls `quitAndInstall()`

**Shell (lines 880–927):**
- `shell:openExternal` — uses `shell.openExternal()`
- `shell:openInEditor` — uses `ShellManager.openInEditor()`
- `shell:discoverAgents` — uses `ShellManager.discoverAgents()`

**Clipboard (line 930):**
- `clipboard:writeText` — uses `clipboard.writeText()`

**Preferences (lines 997–1013):**
- `preferences:getAll`, `preferences:set`, `preferences:playSound`
- `preferences:set` also sends `preferences-changed` to renderer via `getMainWindow()`

**Keybindings (lines 1030–1050):**
- `keybindings:getAll`, `keybindings:set`, `keybindings:reset`, `keybindings:resetAll`
- Handlers that modify keybindings also send `keybindings-changed` to renderer

Export: `export function register(deps: IpcDeps): void`

## 3. Update `electron/main.ts`

Remove extracted blocks, add imports and register calls. At this point main.ts should have NO ipcMain.handle calls remaining.

## Files to touch
- `electron/ipc/tasks.ts` — CREATE
- `electron/ipc/misc.ts` — CREATE
- `electron/main.ts` — MODIFY: remove last handler blocks, add imports and register calls
