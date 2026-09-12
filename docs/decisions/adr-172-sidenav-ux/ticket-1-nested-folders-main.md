---
title: Nested folders — main process, routes, IPC, MCP
status: done
priority: high
assignee: opus
blocked_by: []
---

# Nested folders — main process, routes, IPC, MCP

Give `WorkspaceFolder` a `parentId` and teach the main process to create,
move, promote-on-delete and validate nested folders. Renderer work is
ticket 3; do not touch `src/` except `src/electron.d.ts`.

## Model

```ts
export interface WorkspaceFolder {
  id: string;
  name: string;
  /** Enclosing folder, or null at the top level. */
  parentId: string | null;
}
```

Persisted folders written by older builds have no `parentId`; read that as
`null`. Never write `undefined` — normalize on read in `buildProjectInfo`.

## Behaviour

- `createWorkspaceFolder(projectId, name, parentId?)` — store `parentId` when
  it names an existing folder of this project, otherwise store `null` (same
  forgiving rule `setWorkspaceFolder` already uses for dangling ids). Keep
  appending the new id to `workspaceOrder`.
- `setFolderParent(projectId, folderId, parentId): boolean` — new. Returns
  `false` and changes nothing when `folderId` is unknown, when `parentId` is
  `folderId` itself, or when `parentId` is a descendant of `folderId`.
  Otherwise sets the parent, saves, returns `true`.
- `isFolderDescendant(folders, folderId, candidateId): boolean` — pure,
  exported, tested. True when `candidateId` is `folderId` or sits anywhere
  below it. Must terminate on a corrupt cyclic chain (cap the walk by
  `folders.length`).
- `deleteWorkspaceFolder(projectId, folderId)` — **promote, don't orphan**.
  Child folders (`parentId === folderId`) take the deleted folder's
  `parentId`. Member workspaces take the deleted folder's `parentId` as their
  `workspaceFolderIds` entry, or lose the entry when that parent is `null`.
  `spliceFolderOut` still puts the deleted slot's contents where the folder
  sat — pass member paths *and* child folder ids, in their current
  `workspaceOrder` relative order.
- `buildProjectInfo` — emit `parentId` on every folder, normalized to `null`
  when it names a folder that no longer exists or the folder itself.

## Transport

- `electron/ipc/projects.ts`: new `projects:setFolderParent` handler;
  `projects:createWorkspaceFolder` accepts an optional third `parentId` arg.
- `electron/preload.ts`: matching bindings.
- `src/electron.d.ts`: matching signatures, and `parentId` on the
  `WorkspaceFolder` shape if it is spelled out there.
- `electron/routes/folders.ts`: `POST /projects/:projectId/folders` accepts an
  optional `parentId` (string or null; 400 on any other type). New route
  `POST /projects/:projectId/folders/:folderId/parent` with a `parentId`
  body — 404 via `requireFolder` for an unknown folder or unknown parent,
  409 `{ error: "Would create a folder cycle" }` when `setFolderParent`
  returns false, 200 `{ ok: true }` otherwise. Call `notifyProjectsChanged()`
  on success like its neighbours.
- `electron/mcp/tools-projects.ts`: `create_folder` gains an optional
  `parentId`; `list_folders` reports `parentId`; add a `move_folder` tool
  (`folderId`, `parentId` nullable) wrapping the new route.

## Tests

Extend `electron/persistence.test.ts` and `electron/routes/folders.test.ts`:

- create nested, read back through `buildProjectInfo`
- `setFolderParent` rejects self-parenting and descendant-parenting
- `isFolderDescendant` direct/indirect/absent, and terminates on a cycle
- delete promotes child folders and member workspaces to the grandparent, and
  leaves their slot in `workspaceOrder` where the folder was
- a pre-`parentId` persisted project loads with every folder at the top level
- route: 409 on a cycle, 400 on a bad `parentId` type

## Files to touch
- `electron/persistence.ts` — model, create/setFolderParent/delete, `isFolderDescendant`, `buildProjectInfo`
- `electron/persistence.test.ts` — cases above
- `electron/routes/folders.ts` — optional `parentId` on create, new parent route
- `electron/routes/folders.test.ts` — route cases
- `electron/ipc/projects.ts` — `projects:setFolderParent`, `parentId` on create
- `electron/preload.ts` — bindings
- `electron/mcp/tools-projects.ts` — `parentId` on create/list, `move_folder`
- `src/electron.d.ts` — signatures

## Verify
`pnpm test:unit` and `pnpm lint` pass.
