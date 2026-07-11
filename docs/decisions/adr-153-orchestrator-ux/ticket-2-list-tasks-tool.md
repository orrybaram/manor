---
title: list_tasks MCP tool + /tasks route + taskManager dep threading
status: in-progress
priority: critical
assignee: sonnet
blocked_by: []
---

# list_tasks MCP tool + /tasks route + taskManager dep threading

Expose live session state over MCP so the orchestrator can *see* every session.
Entirely main-served (no renderer round-trip). This ticket also does the
`ControlDeps` threading that ticket 3 builds on, so run it before ticket 3.

## What to build

1. **Thread `taskManager` (and `backend`) into route deps.** `ControlDeps`
   (`electron/routes/types.ts:16-21`) currently has
   `{ projectManager, githubManager, linearManager, layoutPersistence }`. Add
   `taskManager: TaskManager` and `backend` (the pty-owning backend used at
   `electron/ipc/pty.ts`) — ticket 3 needs `backend`, add both now to avoid a
   second threading pass. Wire them through:
   - `electron/webview-server.ts` constructor (~66-78) + the `deps` object passed
     to `handleControlRequest` (~240-247).
   - `electron/ipc/webview.ts` `createWebviewServer` (~37-50).
   - The call site in `electron/app-lifecycle.ts` (~206) — pass the existing
     `taskManager` (constructed ~149) and `backend`.

2. **`GET /tasks` route** — `electron/routes/tasks.ts` (NEW), registered in
   `electron/routes/index.ts:29-36` (add `...tasksRoutes`):
   - Query: `?projectId=&status=&limit=&offset=`.
   - Handler reads `deps.taskManager.getAllTasks({ projectId, status, limit, offset })`
     (`electron/task-persistence.ts:191`); with no filters, may prefer
     `getActiveTasks()` (`:258`). Return JSON array of the relevant `TaskInfo`
     fields: `id`, `name`, `status`, `lastAgentStatus`, `projectId`,
     `projectName`, `workspacePath`, `agentKind`, `paneId`, `linkedIssue`/PR if
     available, timestamps.

3. **`list_tasks` MCP tool** — `electron/mcp/tools-tasks.ts` (NEW), exporting
   `tasksModule: ToolModule` (`electron/mcp/types.ts`):
   - Tool def `list_tasks` with optional `projectId`, `status`, `limit`.
   - Handler: `await http.get("/tasks?" + qs)`, format into a compact text table
     via the `text()` helper — one row per task showing a stable **handle**
     (`id`, and `#<issue>`/branch when present), `lastAgentStatus`, project/branch,
     and `paneId`. The handle must be re-usable as the `target` for
     `send_to_session` (ticket 3).
   - Register `tasksModule` in the `modules` array at
     `electron/mcp-webview-server.ts:123`.

## Files to touch
- `electron/routes/types.ts` — add `taskManager` + `backend` to `ControlDeps`.
- `electron/webview-server.ts` — accept + forward new deps (~66-78, ~240-247).
- `electron/ipc/webview.ts` — pass new deps in `createWebviewServer` (~37-50).
- `electron/app-lifecycle.ts` — supply `taskManager` + `backend` at call site (~206).
- `electron/routes/tasks.ts` — NEW `GET /tasks` handler.
- `electron/routes/index.ts` — register `tasksRoutes` (~29-36).
- `electron/mcp/tools-tasks.ts` — NEW `tasksModule` with `list_tasks`.
- `electron/mcp-webview-server.ts` — add `tasksModule` to `modules` (~123).
