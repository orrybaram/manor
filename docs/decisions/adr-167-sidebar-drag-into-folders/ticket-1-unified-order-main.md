---
title: Normalize a unified sidebar order in the main process
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Normalize a unified sidebar order in the main process

`workspaceOrder` becomes a list of workspace paths **and** folder ids. Expose a
normalized copy on `ProjectInfo`, keep folder create/delete consistent with
it, and unit test the pure helpers. Read
`docs/decisions/adr-167-sidebar-drag-into-folders/index.md` first.

## `electron/persistence.ts`

- `ProjectInfo`: add `sidebarOrder: string[];` (doc comment: normalized,
  depth-first order of workspace paths and folder ids).
- Export pure helpers (module scope, no class state):

```ts
export function normalizeSidebarOrder(
  order: string[] | undefined,
  workspacePaths: string[],   // in git order
  folderIds: string[],        // in workspaceFolders order
): string[]
// keep known entries in order; drop unknown; append missing paths then
// missing folder ids.

export function spliceFolderOut(
  order: string[],
  folderId: string,
  memberPaths: string[],      // members in their current relative order
): string[]
// remove memberPaths wherever they are, then replace the folderId entry with
// them (or append them if the id is absent). Never duplicates a path.
```

- `buildProjectInfo()`: compute `sidebarOrder` via `normalizeSidebarOrder`
  using the raw git workspace paths and `p.workspaceFolders`. Keep the
  existing sort of `workspaces` (folder ids never match a path, so the
  current sort code needs no change).
- `createWorkspaceFolder`: after pushing the folder, if `project.workspaceOrder`
  is an array, push the new id onto it.
- `deleteWorkspaceFolder`: before deleting memberships, collect member paths
  in `workspaceOrder` order (members not in the array go last). If
  `workspaceOrder` exists, replace it with `spliceFolderOut(...)`.
- `reorderWorkspaces(projectId, orderedKeys)`: rename the parameter; add a
  doc comment that entries may be folder ids. No behaviour change.
- Also add `sidebarOrder: []` to the object literal returned by `addProject`
  (it builds a `ProjectInfo` by hand — grep for `folders: []` to find it).

## `electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts`

No new channels. Update the `reorderWorkspaces` parameter name / doc comment
to `orderedKeys` where it appears.

## `electron/mcp/tools-projects.ts`

Local `ProjectInfo` interface: add optional `sidebarOrder?: string[]` so the
type stays a subset of the real one. No formatting change.

## Renderer type mirror

`src/store/project-store.ts` `ProjectInfo`: add `sidebarOrder: string[];`.
Fix any test fixture that constructs a `ProjectInfo` literal (grep for
`folders: []` in `src/**/*.test.ts` and `electron/**/*.test.ts`) by adding
`sidebarOrder: []`.

## Tests (`electron/persistence.test.ts`)

`describe("sidebar order")`:

- `normalizeSidebarOrder`: keeps known order; drops unknown ids and stale
  paths; appends missing paths then missing folder ids; `undefined` input
  yields paths then folder ids.
- `spliceFolderOut`: members scattered elsewhere are gathered into the
  folder's slot; folder id absent → members appended; no duplicates.
- `createWorkspaceFolder` appends the id to an existing `workspaceOrder` and
  leaves an unset one unset.
- `deleteWorkspaceFolder` rewrites `workspaceOrder` so members sit where the
  folder was.
- `buildProjectInfo` returns `sidebarOrder` with a folder id and two paths in
  persisted order (reuse the `gitMock` pattern with `worktreeList` returning
  two entries).

Run `pnpm vitest run electron/persistence.test.ts`, then
`pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec tsc --noEmit -p tsconfig.electron.json`
(no NEW errors in touched files; baseline has unrelated ones).

## Files to touch
- `electron/persistence.ts` — helpers, `sidebarOrder`, create/delete updates
- `electron/persistence.test.ts` — new describe block
- `electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts` — parameter naming only
- `electron/mcp/tools-projects.ts` — optional `sidebarOrder` on local type
- `src/store/project-store.ts` — `sidebarOrder` on `ProjectInfo`
- test fixtures constructing `ProjectInfo` literals — add `sidebarOrder: []`
