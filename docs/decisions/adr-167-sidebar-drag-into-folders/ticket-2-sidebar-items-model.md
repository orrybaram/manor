---
title: Pure sidebar item model, drop resolution, and store wiring
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Pure sidebar item model, drop resolution, and store wiring

Create `src/utils/sidebar-items.ts`, the pure module that turns a project into
an ordered item tree, applies drops and menu moves to that tree, and
serializes it back to a canonical order. Wire the store to it. Delete the
ADR-166 module it replaces. Read
`docs/decisions/adr-167-sidebar-drag-into-folders/index.md` first — the
"Renderer view model" section is the spec.

## `src/utils/sidebar-items.ts` (new)

Export exactly:

```ts
export type SidebarItem =
  | { kind: "workspace"; ws: WorkspaceInfo }
  | { kind: "folder"; folder: WorkspaceFolder; workspaces: WorkspaceInfo[] };

export type Row = { key: string; kind: "workspace" | "folder"; parentFolderId: string | null };

export type DropTarget =
  | { type: "slot"; rowIndex: number }
  | { type: "into"; folderId: string };

export function buildSidebarItems(project: Pick<ProjectInfo, "workspaces" | "folders" | "sidebarOrder">): SidebarItem[];
export function flattenRows(items: SidebarItem[], collapsedFolderIds: Set<string>, dragging: "workspace" | "folder"): Row[];
export function applyDrop(items: SidebarItem[], sourceKey: string, target: DropTarget, rows: Row[]): SidebarItem[];
export function serializeOrder(items: SidebarItem[], project: Pick<ProjectInfo, "workspaces" | "sidebarOrder">): string[];
export function membershipOf(items: SidebarItem[]): Map<string, string | null>; // path → folderId
export function placeInFolder(items: SidebarItem[], path: string, folderId: string): SidebarItem[];
export function placeAfterFolder(items: SidebarItem[], path: string, folderId: string): SidebarItem[];
export function insertFolderBefore(items: SidebarItem[], folder: WorkspaceFolder, anchorPath: string): SidebarItem[];
```

Semantics:

- **buildSidebarItems** — iterate `sidebarOrder`. A folder id yields a folder
  item whose members are the non-hidden workspaces with that `folderId`,
  ordered by their index in `sidebarOrder` (members missing from the order go
  last, in `project.workspaces` order). A path yields a workspace item only if
  the workspace is visible and has no (valid) folder. Folders with no members
  are included. Anything in `project.workspaces`/`project.folders` that is
  not in `sidebarOrder` is appended (workspaces first, then folders) — this
  is defensive; ticket 1 normalizes in main so it should not happen.
- **flattenRows** — `dragging === "folder"`: one row per top-level item
  (`kind: "folder"` rows for folders, `kind: "workspace"` for loose rows),
  all `parentFolderId: null`. `dragging === "workspace"`: loose rows, then
  for each folder a header row (`key: folder.id, kind: "folder"`) followed by
  member rows (`parentFolderId: folder.id`) only if the folder is not
  collapsed.
- **applyDrop** — `rows` is the row list the drag ran on (from
  `flattenRows`), `sourceKey` is in it, `target.rowIndex` is the index the
  source occupies *after* removal-and-reinsertion (identical to the
  `finalDrop` semantic in `useWorkspaceDrag`). Steps: remove the source from
  the tree; compute the row list without the source; the row at
  `rowIndex - 1` (if any) is the **predecessor**. Workspace source:
  predecessor is a member of F or F's header row where F is expanded (its
  members appear in `rows`) → insert into F right after the predecessor (or
  first if the predecessor is the header); predecessor is a collapsed folder
  header → insert loose right after F; predecessor is a loose workspace →
  insert loose after it; no predecessor → first. `target.type === "into"` →
  append to that folder. Folder source: `rows` are top-level only, so insert
  at the top-level index directly. A folder can never end up inside another
  folder.
- **serializeOrder** — depth-first: loose path or folder id followed by its
  member paths. Then append every hidden workspace path (they are not in
  `items`) in their previous `sidebarOrder` relative order, and finally any
  remaining path from `project.workspaces` not yet emitted.
- **membershipOf** — for every workspace in the tree, its folder id or null.
- **placeInFolder** — remove the path from wherever it is, append to the
  folder's members. **placeAfterFolder** — remove from the folder, insert as
  a loose item right after that folder. **insertFolderBefore** — insert the
  new folder (empty) as a top-level item immediately before the top-level
  item that contains `anchorPath` (the loose row itself, or the folder it is
  in); if not found, append.

## Tests (`src/utils/sidebar-items.test.ts`, new)

Build fixtures with a small factory (`ws(path, folderId?, hidden?)`,
`folder(id, name)`). Cover at minimum:

- build: order respected; hidden excluded; empty folder kept; stale membership
  → loose; members ordered by `sidebarOrder`.
- flattenRows: both modes; collapsed folder hides members.
- applyDrop, workspace source: loose → loose reorder; loose → into folder via
  `into`; loose → into expanded folder via slot after header; slot after last
  member stays inside; slot after collapsed header is loose; member → loose
  by dropping at index 0; member → other folder.
- applyDrop, folder source: reorder among top-level; moving above `local`;
  members travel with it.
- serializeOrder: canonical form; hidden paths appended and stable across two
  successive edits; round-trip `buildSidebarItems(serializeOrder(...))`
  equals the tree.
- placeInFolder / placeAfterFolder / insertFolderBefore.

## `src/store/project-store.ts`

- Rename `reorderWorkspaces` → `reorderSidebar(projectId, orderedKeys)`;
  still calls `window.electronAPI.projects.reorderWorkspaces`. Optimistic
  update sets `sidebarOrder: orderedKeys` and re-sorts `workspaces` by their
  index in it (paths absent keep relative order at the end). Update the one
  caller in `src/components/sidebar/Sidebar/Sidebar.tsx`
  (`onReorderWorkspaces` prop → `onReorderSidebar`; `ProjectItem`'s prop
  renamed to match — ticket 3 will consume it, so just rename the
  pass-through now).
- New `applySidebarChange(projectId, next: SidebarItem[]): Promise<void>`:
  read the project, compute `order = serializeOrder(next, project)` and
  `membership = membershipOf(next)`; diff membership against current
  `ws.folderId` (treat undefined as null); optimistically set `sidebarOrder`,
  patched `folderId`s, and re-sorted `workspaces`; then for each changed path
  `await projects.setWorkspaceFolder(...)`, then
  `await projects.reorderWorkspaces(projectId, order)`.
- `createWorkspaceFolder(projectId, name, anchorPath?)`: after the IPC
  result, append the folder locally and push its id onto `sidebarOrder`; if
  `anchorPath` is given, `applySidebarChange(projectId, placeInFolder(insertFolderBefore(items, folder, anchorPath), anchorPath, folder.id))`.
- `deleteWorkspaceFolder`: optimistic update also rewrites `sidebarOrder` the
  way main does (members take the folder's slot) — reuse `spliceFolderOut`
  logic by re-implementing the 6 lines locally or importing from a shared
  spot; do **not** import from `electron/` into the renderer.
- `setWorkspaceFolder` stays as-is (menu callers now go through
  `applySidebarChange` with `placeInFolder`/`placeAfterFolder`; keep the raw
  action for MCP-style callers).

## Delete

- `src/utils/workspace-folders.ts` and `src/utils/workspace-folders.test.ts`.
  `ProjectItem.tsx` imports `groupWorkspaces`/`mergeSectionOrder` from it;
  until ticket 3 rewires the UI, replace those two imports with the minimal
  equivalent built on `buildSidebarItems` (loose = workspace items, folders =
  folder items) and a local `mergeSectionOrder` copy marked
  `// TODO(adr-167 ticket 3): removed with WorkspaceList`. Typecheck and
  `pnpm knip:ci` must pass at the end of this ticket.

Run `pnpm vitest run src/utils/sidebar-items.test.ts`, `pnpm test`
(includes `knip:ci`), and the two `tsc --noEmit` commands (no NEW errors).

## Files to touch
- `src/utils/sidebar-items.ts` — new pure module
- `src/utils/sidebar-items.test.ts` — new tests
- `src/store/project-store.ts` — `reorderSidebar`, `applySidebarChange`, folder action updates
- `src/components/sidebar/Sidebar/Sidebar.tsx` — prop rename pass-through
- `src/components/sidebar/ProjectItem.tsx` — import swap only (temporary shim)
- `src/utils/workspace-folders.ts`, `src/utils/workspace-folders.test.ts` — delete
