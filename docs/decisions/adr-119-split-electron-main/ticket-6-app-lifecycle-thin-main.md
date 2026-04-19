---
title: Extract app lifecycle and slim down main.ts
status: done
priority: critical
assignee: opus
blocked_by: [5]
---

# Extract app lifecycle and slim down main.ts

## 1. `electron/app-lifecycle.ts`

Move from `electron/main.ts`:

**Service instantiation (lines 232–253):**
All `new TerminalHostClient()`, `new LocalBackend(client)`, `new LayoutPersistence()`, etc. Create a function that instantiates all services and builds the `IpcDeps` object.

**Pre-whenReady side effects (lines 270–344):**
- `ShellManager.setupZdotdir()`
- `ensureHookScript()`, `ensureWebviewCli()`, `registerAllAgents()`
- `backend.pty.onEvent(...)` stream relay — forwards PTY events to renderer via `mainWindow.webContents.send()`

**`app.whenReady()` contents (lines 1396–1691):**
- Menu construction (lines 1398–1454) — the full `Menu.buildFromTemplate([...])` with View zoom shortcuts
- Dock icon setup (line 1455)
- `createWindow()` call and dev title logic
- `initAutoUpdater(mainWindow)`
- Server startup sequence: `agentHookServer.start()`, `webviewServer.start()`, `portlessManager.start()`
- `backend.connect(...)` call
- IPC registration — call all `register(deps)` functions from the ipc/ modules
- **`agentHookServer.setRelay(...)` callback (lines 1544–1691)** — the task lifecycle state machine:
  - `SessionState` interface and `sessionStateMap`
  - `paneRootSessionMap`
  - `ACTIVE_STATUSES` set
  - `getOrCreateSessionState()` helper
  - `broadcastTask()` helper (sends `task-updated` to renderer, calls `updateDockBadge()`)
  - Handles events: `session_start`, `session_end`, `subagent_start`, `subagent_end`, `status_change`, `cost_update`

**App event handlers (lines 1693–1710):**
- `app.on("activate", ...)` — re-create window
- `app.on("window-all-closed", ...)` — quit on non-macOS
- `app.on("before-quit", ...)` — stop agentHookServer, webviewServer, portlessManager

Export: `export function initApp(): void`

## 2. Slim down `electron/main.ts`

After extraction, main.ts should be ~20–40 lines:

```typescript
// electron/main.ts — Thin entry point
import { app } from 'electron';
import { initApp } from './app-lifecycle';

// Fix PATH for packaged app (must run before whenReady)
// ... the 20-line PATH fix block (lines 1360–1380) stays here or moves to a small helper

// Dev mode: set app name to include branch
// ... lines 1386–1393

initApp();
```

The PATH fix and dev app name logic (lines 1360–1393) can stay in main.ts since they must execute at module load time before `app.whenReady()`.

## 3. `electron/ipc/index.ts` (optional convenience)

Create a barrel that re-exports all register functions:
```typescript
export { register as registerPtyIpc } from './pty';
export { register as registerLayoutIpc } from './layout';
// ... etc
```

This keeps app-lifecycle.ts clean — it can do:
```typescript
import * as ipc from './ipc';
// then call each ipc.registerXxxIpc(deps)
```

Or create a single `registerAllIpc(deps)` function that calls all of them.

## Files to touch
- `electron/app-lifecycle.ts` — CREATE: initApp(), service instantiation, menu, servers, relay, app events
- `electron/ipc/index.ts` — CREATE: barrel exports or registerAll
- `electron/main.ts` — MODIFY: reduce to thin entry point (~30 lines)
