---
title: Persist workspace folders and expose them over IPC
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Persist workspace folders and expose them over IPC

Add the folder data model to the main process, four `ProjectManager`
methods, four IPC channels, and the preload/type mirrors. Include unit tests.
Folders are project-scoped, flat, and purely metadata — they never touch git.

## Data model (`electron/persistence.ts`)

```ts
export interface WorkspaceFolder { id: string; name: string }
```

- `WorkspaceInfo`: add `folderId?: string | null;`
- `ProjectInfo`: add `folders: WorkspaceFolder[];`
- `PersistedProject`: add `workspaceFolders?: WorkspaceFolder[];` and
  `workspaceFolderIds?: Record<string, string>;` (workspace path → folder id).
- `buildProjectInfo()`: set `folders: p.workspaceFolders ?? []`. For each
  workspace, `folderId` = the mapped id **only if** that id exists in
  `workspaceFolders`; otherwise `null`. Never leave a dangling id in the
  returned info.
- `removeWorktree()` metadata cleanup: also `delete
  project.workspaceFolderIds?.[worktreePath]`.

New methods, each ending in `this.saveState()`:

- `createWorkspaceFolder(projectId: string, name: string): WorkspaceFolder | null`
  — trim name; return `null` for unknown project or empty name; id via
  `crypto.randomUUID()`; push onto `workspaceFolders` (create array if missing).
- `renameWorkspaceFolder(projectId: string, folderId: string, name: string): void`
  — trim; no-op when empty or folder not found.
- `deleteWorkspaceFolder(projectId: string, folderId: string): void` — remove
  the folder; delete every `workspaceFolderIds` entry whose value is that id.
- `setWorkspaceFolder(projectId: string, workspacePath: string, folderId: string | null): void`
  — if `folderId` is `null` or not an existing folder id, delete the entry;
  otherwise set it.

## IPC (`electron/ipc/projects.ts`)

Register next to `projects:setWorkspaceHidden`:

- `projects:createWorkspaceFolder` (projectId, name) → returns the folder.
  `assertString(name, "name")`.
- `projects:renameWorkspaceFolder` (projectId, folderId, name).
  `assertString(name, "name")`.
- `projects:deleteWorkspaceFolder` (projectId, folderId).
- `projects:setWorkspaceFolder` (projectId, workspacePath, folderId | null).

## Preload + types

- `electron/preload.ts`: add the four `projects.*` methods following
  `setWorkspaceHidden`'s shape.
- `src/electron.d.ts`: add matching signatures. `createWorkspaceFolder`
  returns `Promise<import("./store/project-store").WorkspaceFolder | null>`.
  (Ticket 2 adds that export to the store; for this ticket, declare the type
  as an inline `{ id: string; name: string } | null` so typecheck passes
  without the store change.)

## MCP formatting (`electron/mcp/tools-projects.ts`)

`formatWorkspace(ws)` — append ` [folder: <name>]` when `ws.folderId` resolves
to a folder. `formatWorkspace` currently only receives the workspace; extend
it to take an optional `folders: WorkspaceFolder[]` second argument and update
its two call sites (`formatProject`, `list_workspaces`) to pass
`project.folders` where available. Update the local `WorkspaceInfo`/
`ProjectInfo` interfaces in that file to include `folderId` and `folders`.

## Tests (`electron/persistence.test.ts`)

Add a `describe("workspace folders")` block modelled on `renameWorkspace`:

- create → folder appears in `projects.json` under `workspaceFolders` with a
  non-empty id and trimmed name.
- create with empty/whitespace name → returns `null`, nothing persisted.
- rename → name updated; empty rename is a no-op.
- setWorkspaceFolder → `workspaceFolderIds[path]` set; `null` removes it;
  unknown id removes it.
- deleteWorkspaceFolder → folder gone and every membership for it gone.
- `buildProjectInfo` resolves `folderId` (use the `gitMock` pattern from the
  `createWorktree` block with `worktreeList` returning two worktrees), and
  returns `null` for a stale id written directly into the JSON.

Run `pnpm vitest run electron/persistence.test.ts` and `pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec tsc --noEmit -p tsconfig.electron.json`
(check `package.json` for the exact script names).

## Files to touch
- `electron/persistence.ts` — types, buildProjectInfo overlay, removeWorktree cleanup, four methods
- `electron/persistence.test.ts` — new describe block
- `electron/ipc/projects.ts` — four handlers
- `electron/preload.ts` — four bridge methods
- `src/electron.d.ts` — four signatures
- `electron/mcp/tools-projects.ts` — folder label in `formatWorkspace`
