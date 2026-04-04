---
title: Extract theme, ports, and branches-diffs IPC handlers
status: in-progress
priority: high
assignee: sonnet
blocked_by: [2]
---

# Extract theme, ports, and branches-diffs IPC handlers

## 1. `electron/ipc/theme.ts`

Move from `electron/main.ts` (lines 557–580):
- All 6 `theme:*` handlers — use `themeManager`

Export: `export function register(deps: IpcDeps): void`

## 2. `electron/ipc/ports.ts`

Move from `electron/main.ts`:
- `enrichPorts()` helper (lines 583–602) — uses `portlessManager`
- All 6 `ports:*` handlers (lines 604–638) — use `portScanner`, `getMainWindow()`
- The `portScanner.on("ports-changed", ...)` event listener that sends `ports-changed` to renderer (line ~637)

Note: `enrichPorts` uses `portlessManager` which is imported at module level. Either add `portlessManager` to IpcDeps or import it directly since it's a singleton export.

Export: `export function register(deps: IpcDeps): void`

## 3. `electron/ipc/branches-diffs.ts`

Move from `electron/main.ts`:
- `branches:start`, `branches:stop` (lines 641–647) — use `branchWatcher`
- `diffs:start`, `diffs:stop`, `diffs:getFullDiff`, `diffs:getLocalDiff`, `diffs:getStagedFiles` (lines 650–678) — use `diffWatcher`
- `git:stage`, `git:unstage`, `git:discard`, `git:stash`, `git:commit` (lines 681–704) — use `backend.git`

Export: `export function register(deps: IpcDeps): void`

## 4. Update `electron/main.ts`

Remove extracted blocks, add imports and register calls following the same pattern as ticket 2.

## Files to touch
- `electron/ipc/theme.ts` — CREATE
- `electron/ipc/ports.ts` — CREATE
- `electron/ipc/branches-diffs.ts` — CREATE
- `electron/main.ts` — MODIFY: remove extracted handlers, add imports and register calls
