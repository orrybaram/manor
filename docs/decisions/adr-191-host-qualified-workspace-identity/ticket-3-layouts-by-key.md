---
title: Saved layouts keyed by host plus path, in the renderer and the daemon
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Saved layouts keyed by host plus path, in the renderer and the daemon

GitHub issue #240. See ADR-191 §3.

- `electron/terminal-host/layout-persistence.ts`: key each persisted
  workspace by `workspaceKey`, and bump the file to `version: 3`. On load, a
  version 2 file is migrated once with `migrateWorkspaceKey`, using the
  projects in `projects.json` as owners. Expand each worktree root for its
  host and pass it as `worktreeRoot`. Keep `lastActiveWorkspacePath` in step.
  The migration must never drop a layout.
- `src/store/app-store.ts`: `workspaceLayouts` and `activeWorkspacePath`
  lookups use the workspace key of the active workspace. It is loaded through
  `layout.load()`, so no separate renderer migration is needed.
- `src/store/navigation-history-store.ts`: workspace entries are keyed and
  compared by `workspacePath`. Key them by the workspace key, so going back
  never lands in the other host's workspace with the same path.
- `electron/pane-context.ts` `findWorkspaceForPane` now returns a key. Parse
  it where a path is needed, or coordinate with ticket 4.
- Tests: two workspaces with the same path on different hosts keep separate
  layouts across a save and load. A version 2 file migrates, and a
  local-only file keeps every entry's path. Extend the layout-persistence and
  layout-snapshot tests.

## Files to touch
- `electron/terminal-host/layout-persistence.ts` and its test.
- `src/store/app-store.ts`, `src/store/layout-snapshot.ts`, and the layout tests.
- `src/store/navigation-history-store.ts` and its test.
- The main-process call site that loads the layout with the project list.
