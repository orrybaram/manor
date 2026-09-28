---
title: Saved layouts keyed by host plus path, in the renderer and the daemon
status: done
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

## Implementation notes

- The persisted field keeps its name, `workspacePath`, and holds the
  workspace key from version 3, as does `lastActiveWorkspacePath`. A
  downgrade still finds every local workspace.
- Main runs the migration once at launch
  (`LayoutPersistence.startWorkspaceKeyMigration`); `layout:load` and
  `layout:save` wait for it. The owners are `projects.json`'s projects with
  their worktree roots expanded on their hosts, their workspaces as their
  hosts' git lists them, and the workspace paths the file remembers. If a
  remote host doesn't answer within 5 seconds, the file stays at version 2
  and the migration runs again next launch: a partial owner list would send
  some paths to the wrong host for good.
- While the file is still at version 2, the renderer reads and saves the
  workspace the migration will give a bare path to under that bare path, and
  any other host's workspace at that path under its qualified key. The
  migration keeps a layout with tabs over an empty one when two entries meet.
- The renderer keeps `activeWorkspacePath` as a path and adds
  `activeWorkspaceHostId`; `selectActiveWorkspaceKey` combines them. Panes
  take their host from the key of the layout they are in
  (`paneCreateHostId`), not from the selected project.
- A host move (`projects:moveToHost`, `projects:switchHost`) moves the saved
  layouts of the workspaces the project keeps to their keys on the new host,
  in `layout.json` and in the renderer.
- Downgrading: an older build keeps the `<hostId>:<path>` entries in
  `layout.json` but ignores them. A remote workspace's layout that it saves
  under a bare path is read as local after upgrading again, since the file
  is already at version 3.
