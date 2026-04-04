---
title: Extract PTY, layout, and projects IPC handlers
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1]
---

# Extract PTY, layout, and projects IPC handlers

## 1. `electron/ipc/pty.ts`

Move from `electron/main.ts` (lines 349–421):
- `pty:create` handler — uses `backend.pty.create()`, `backend.pty.resize()`, reads `readBranchSync()` to build env, accesses `workspaceMeta`
- `pty:write` — uses `backend.pty.write()`
- `pty:resize` — uses `backend.pty.resize()`
- `pty:close` — uses `backend.pty.close()`
- `pty:detach` — uses `backend.pty.detach()`

Also move `readBranchSync()` (lines 70–97) into this module since it's only used by `pty:create`.

Export: `export function register(deps: IpcDeps): void`

The `pty:create` handler also references `agentHookServer.port` via env vars. Add `agentHookServerPort` to IpcDeps or pass it separately. Check if it can be read from `process.env.MANOR_HOOK_PORT` instead (it's set globally at line 1481).

## 2. `electron/ipc/layout.ts`

Move from `electron/main.ts` (lines 424–449):
- `layout:save` — uses `layoutPersistence.save()`
- `layout:load` — uses `layoutPersistence.load()`
- `layout:getRestoredSessions` — uses `layoutPersistence.getRestoredSessions()`

Export: `export function register(deps: IpcDeps): void`

## 3. `electron/ipc/projects.ts`

Move from `electron/main.ts` (lines 452–554):
- All 16 `projects:*` handlers
- These use `projectManager`, `getMainWindow()` (for sending `projects:removeWorktree:progress`)
- `projects:update` references `import("./persistence").ProjectUpdatableFields` type

Export: `export function register(deps: IpcDeps): void`

## 4. Update `electron/main.ts`

Remove the extracted handler blocks and replace with:
```typescript
import { register as registerPtyIpc } from './ipc/pty';
import { register as registerLayoutIpc } from './ipc/layout';
import { register as registerProjectsIpc } from './ipc/projects';
```

Call these register functions after service instantiation, passing the deps object.

## Files to touch
- `electron/ipc/pty.ts` — CREATE
- `electron/ipc/layout.ts` — CREATE
- `electron/ipc/projects.ts` — CREATE
- `electron/main.ts` — MODIFY: remove extracted handlers, add imports and register calls
