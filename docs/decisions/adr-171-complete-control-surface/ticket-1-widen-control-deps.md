---
title: Widen ControlDeps to the full manager bag and extract inline IPC logic
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Widen ControlDeps to the full manager bag and extract inline IPC logic

Give routes the same dependencies IPC handlers have, and pull the logic some IPC handlers carry inline into shared functions so routes can call it without duplication.

## Part A — `ControlDeps`

1. `electron/routes/types.ts`: add to `ControlDeps` (all `| null`):
   `notificationStore: NotificationStore`, `statsStore: StatsStore`, `preferencesManager: PreferencesManager`, `themeManager: ThemeManager`, `portScanner: PortScanner`, `remoteControl: RemoteControlController`, `agentHookServer: AgentHookServer`, and `getRendererWindows: (() => BrowserWindow[])` (nullable too). Import types only.
2. `electron/webview-server.ts`: add `setControlDeps(deps: Partial<ControlDeps>): void` that stores the bag; `handleControlRequest` is called with `{ ...positionalFallbacks, ...this.controlDeps }` so the six constructor args keep working when the setter was never called (unit tests).
3. `electron/app-lifecycle.ts`: immediately after `const ipcDeps = {...}` (line ~374), call `webviewServer.setControlDeps({ projectManager, githubManager, linearManager, layoutPersistence, agentManager, backend, notificationStore, statsStore, preferencesManager, themeManager, portScanner, remoteControl, agentHookServer, getRendererWindows })`, pulling each from `ipcDeps`.

## Part B — extract inline IPC logic

4. New `electron/process-control.ts` exporting pure functions that take what they need explicitly (no `IpcDeps`):
   - `listProcesses({ backend, agentHookServer, webviewServer, portlessManager })` — move the body of `processes:list` from `electron/ipc/processes.ts` verbatim.
   - `cleanupDeadProcesses(backend)`, `killDaemon()`, `restartPortless()`, `killAllProcesses({...})` — same treatment for the other four handlers.
   `electron/ipc/processes.ts` becomes `ipcMain.handle("processes:list", () => listProcesses({...}))` etc.
5. New `electron/editor.ts` exporting `openInEditor(preferencesManager, dirPath): Promise<string | void>` with the body of `shell:openInEditor` from `electron/ipc/misc.ts`; the IPC handler calls it.
6. Nothing else moves. Notification broadcasting already has a single send-site (`sendNotificationsUpdate` in `electron/notifications.ts`); routes will import it directly.

## Tests
- `electron/routes/router.test.ts` and `electron/__tests__/webview-server.test.ts` must still pass unchanged.
- New `electron/process-control.test.ts`: `listProcesses` with a fake backend whose `listSessions` returns two sessions, one not in the active layout set → that one is `orphaned: true`. Mock `LayoutPersistence` the way other tests in `electron/__tests__/` do.

## Files to touch
- `electron/routes/types.ts` — widen `ControlDeps`
- `electron/webview-server.ts` — `setControlDeps`, merge into `handleControlRequest` call
- `electron/app-lifecycle.ts` — call the setter after `ipcDeps`
- `electron/process-control.ts` — new
- `electron/process-control.test.ts` — new
- `electron/ipc/processes.ts` — thin callers
- `electron/editor.ts` — new
- `electron/ipc/misc.ts` — call `openInEditor`
