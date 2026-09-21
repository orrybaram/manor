---
title: One HostDeps for routes and bridge; routes call bridge handlers
status: in-progress
priority: medium
assignee: opus
blocked_by: [9]
---

# One HostDeps for routes and bridge; routes call bridge handlers

ADR-182 D8, deps half.

## Problem
- `ControlDeps` (`electron/routes/types.ts:27-51`) is all-nullable. `IpcDeps` holds the same managers non-null.
- `setControlDeps` copies them over field by field (`app-lifecycle.ts:~516-531`).
- `webview-server.ts:~283-303` holds an all-null default. The nulls are never observable, because `setControlDeps` runs before `webviewServer.start()`.
- Because of this, `routes/agents.ts` re-implements `broadcastAgentUpdate` (~135) and the delete and mark-seen logic (~726-757). The route versions skip `updateDockBadge`.

## Change
- **One deps type.** Make routes take the same non-null `HostDeps` the bridge uses (`IpcDeps`, renamed). Pass it straight through, and delete the copy, the null default and the roughly 20 null guards.
- **Agent routes.** `routes/agents.ts` calls `agentsDelete` / `agentsMarkSeen` from `bridge/handlers/agents.ts`. Delete the route's own `broadcastAgentUpdate`.
- **Agent command resolution:**
  - Move the precedence into a pure, dependency-free `resolveAgentCommand({ override, workspacePath, homePrefs, projects })` in `src/agent-defaults.ts` (or the existing import-free leaf).
  - Both `routes/agents.ts:~283` and the renderer's `getAgentCommand` call it.
  - Remove the "main-process twin" duplicate.
- **Window parameters.** Drop the vestigial `_mainWindow` parameter from `sendNotificationsUpdate` and `markAgentNotificationsRead` (`electron/notifications.ts`) and from their 8+ callers. Delete the `BrowserWindow.getAllWindows()[0]` lookups that exist only to pass it (`routes/agents.ts:~752`, `routes/system.ts:~61`).
- **Bridge construction order.** In `app-lifecycle.ts`, build `ipcDeps` and the bridge before registering `backend.pty.onEvent`, so `bridgeServer`, `wsBridge` and `ipcBridge` become `const` (~376-378, ~437).
- **`createWorktree` options.** `ProjectManager.createWorktree` (`electron/persistence.ts:~1208`) takes `(projectId, name, opts: { branch?, linkedIssue?, baseBranch?, useExistingBranch?, origin? })`. Update the bridge handler, the d.ts and `Sidebar.tsx:~420`.

## Files to touch
- `electron/routes/types.ts`, `electron/routes/*.ts`, `electron/webview-server.ts`, `electron/app-lifecycle.ts`, `electron/notifications.ts`, `electron/persistence.ts`
- `electron/bridge/handlers/agents.ts`, `electron/bridge/handlers/projects.ts`, `src/agent-defaults.ts`, `src/electron.d.ts`, `src/components/sidebar/Sidebar/Sidebar.tsx`, and the tests
