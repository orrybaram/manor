---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-167: Unified sidebar order with drag-into-folder

Extends ADR-166 (issue #178). Supersedes its "loose first, then folders" and
"drag within a section only" decisions.

## Context

ADR-166 shipped folders as a presentational overlay: `workspaceOrder` orders
workspaces, `workspaceFolders` lists folders in creation order, and the
sidebar renders every loose workspace first, then every folder. Drag reorder
runs inside one section at a time (`WorkspaceList` owns a `useWorkspaceDrag`
per section), and moving a workspace between sections is a context-menu
action.

Manual testing surfaced two gaps immediately:

1. **Drag-and-drop into a folder.** Dragging a row onto a folder header, or
   into an expanded folder's member list, is the gesture people reach for.
   The menu path works but is slower and undiscoverable.
2. **Folders are pinned below every loose workspace and cannot be reordered.**
   A user who wants `local`, then a folder, then a couple of loose branches
   has no way to express that. Folders must be items *in* the workspace list,
   draggable alongside workspaces.

Both gaps come from the same root: there is no single ordered list of what the
sidebar shows. Fixing that is the decision here.

Relevant existing machinery:

- `electron/persistence.ts` `PersistedProject.workspaceOrder: string[]` of
  workspace paths, applied as a sort key in `buildProjectInfo()`. Paths not in
  the list sort last, in `git worktree list` order.
- `reorderWorkspaces(projectId, orderedPaths)` stores the array verbatim.
- `src/hooks/useWorkspaceDrag.ts` and its generic sibling
  `src/hooks/useListDrag.ts`: pointer-capture vertical drag, per-item height
  measurement at drag start, cumulative-height drop-index search, shift
  neighbours with `translateY`. Indexed by position, single flat list.
- `src/utils/workspace-folders.ts` (`groupWorkspaces`, `mergeSectionOrder`),
  `src/components/sidebar/WorkspaceList.tsx`, `FolderItem.tsx` — all from
  ADR-166.

## Decision

### One persisted order, canonical form

`workspaceOrder` becomes the **sidebar order**: an array whose entries are
workspace paths *or* folder ids. Its canonical form is depth-first:

```
[ "/…/local", "<folder-A-id>", "/…/auth-login", "/…/auth-signup", "/…/loose-2", "<folder-B-id>", … ]
```

A folder id is followed immediately by its members' paths. Membership itself
still lives in `workspaceFolderIds` (path → folder id); the order array only
says *where* things sit. This keeps every ADR-166 invariant (dangling ids
resolve to null, hidden is orthogonal, removal cleans up) and adds one:
position is a single list, so a folder is just another entry that can move.

The persisted array may be stale or partial (new worktree, never reordered,
folder created by an older build). `buildProjectInfo()` therefore exposes a
**normalized** copy as `ProjectInfo.sidebarOrder: string[]`:

- keep entries that name an existing workspace path or folder id, in order;
- drop everything else;
- append missing workspace paths in git order, then missing folder ids.

`normalizeSidebarOrder(order, paths, folderIds)` is a pure exported function
in `electron/persistence.ts` with unit tests. The renderer never reads the raw
array.

### Main-process changes

- `reorderWorkspaces(projectId, orderedKeys)` — same IPC and signature, the
  argument now carries folder ids too. Stored verbatim.
- `createWorkspaceFolder` also appends the new id to `workspaceOrder` when
  that array exists (normalization covers the unset case).
- `deleteWorkspaceFolder` splices the folder id out of `workspaceOrder` and
  puts its members' paths in its place, in their current relative order, so
  ungrouped workspaces appear where the folder was. Pure helper
  `spliceFolderOut(order, folderId, memberPaths)`, tested.
- `setWorkspaceFolder` stays membership-only. Placement is the renderer's job
  (below) because the renderer already holds the normalized order.
- `removeWorktree` cleanup is unchanged: filtering the path out of the array
  is still correct.

### Renderer view model: `src/utils/sidebar-items.ts`

Replaces `src/utils/workspace-folders.ts` (deleted, with its test).

```ts
type SidebarItem =
  | { kind: "workspace"; ws: WorkspaceInfo }
  | { kind: "folder"; folder: WorkspaceFolder; workspaces: WorkspaceInfo[] };

buildSidebarItems(project): SidebarItem[]
//  walk sidebarOrder; hidden excluded; folder members = workspaces whose
//  folderId matches, ordered by their sidebarOrder index; empty folders kept.

type Row = { key: string; kind: "workspace" | "folder"; parentFolderId: string | null };

flattenRows(items, collapsedIds, dragging: "workspace" | "folder"): Row[]
//  dragging a folder  → one row per top-level item (a folder block is one row)
//  dragging a workspace → folder header row, then member rows if expanded

type DropTarget =
  | { type: "slot"; rowIndex: number }          // land at this row index
  | { type: "into"; folderId: string };         // append to this folder

applyDrop(items, sourceKey, target, rows): SidebarItem[]
//  Pure tree edit. Slot semantics for a workspace: the row that precedes the
//  landing position decides the parent — a member of F or F's *expanded*
//  header → inside F; a collapsed header, a loose workspace, or nothing →
//  loose. A folder only ever lands between top-level items; slots inside a
//  folder snap to the nearest top-level boundary. No nesting.

serializeOrder(items, project): string[]
//  Canonical depth-first order; hidden workspaces appended after visible
//  ones in their previous relative order so they keep a stable slot.

placeInFolder(items, path, folderId): SidebarItem[]   // menu "Move to Folder"
placeAfterFolder(items, path, folderId): SidebarItem[] // menu "Remove from Folder"
insertFolderBefore(items, folder, anchorPath): SidebarItem[] // "New Folder…" from a row
```

Every function is pure and unit tested; this module is where the behaviour
lives, so the tests here are the ones that matter.

### Store: `src/store/project-store.ts`

- `ProjectInfo.sidebarOrder: string[]`.
- `applySidebarChange(projectId, next: SidebarItem[])`: derives the order via
  `serializeOrder` and the moved workspace's membership from the tree,
  updates `sidebarOrder` and any changed `folderId` optimistically, then
  invokes `projects:setWorkspaceFolder` for each membership change and
  `projects:reorderWorkspaces` with the new order.
- `createWorkspaceFolder(projectId, name, anchorPath?)`: after the IPC returns
  the folder, if `anchorPath` is given, build `insertFolderBefore` +
  `placeInFolder` and call `applySidebarChange`, so "New Folder…" from a row
  drops the folder in that row's slot with the row inside it.
- `reorderWorkspaces` is renamed `reorderSidebar` (one caller in
  `Sidebar.tsx`) to make the key semantics visible at the call site.
- `deleteWorkspaceFolder` and `setWorkspaceFolder` optimistic updates also
  patch `sidebarOrder` to match what main will persist.

### Drag: `src/hooks/useSidebarDrag.ts`

A rewrite of `useWorkspaceDrag` keyed by `Row.key` instead of index, one
instance per project:

- `handleDragStart(key, e)` picks the row set from `flattenRows` for the
  source's kind, measures every row's height from `rowRefs` (a folder block
  measures its `.folder` element; a header row its `.folderHeader`; a
  workspace its row element; `+ 8px` gap as today), captures the pointer.
- Drop index search is the existing cumulative-height loop over rows.
- **Into detection** (workspace drags only): when the pointer's absolute Y is
  inside the middle 50% of a folder header row's rect, the target becomes
  `{ type: "into", folderId }`, neighbour shifting is suppressed, and the
  header is flagged so it can render a drop highlight. Leaving that band
  falls back to slot mode.
- Returns `dragKey`, `intoFolderId`, `getTransformStyle(key)`, `rowRefs`,
  `justDragged`, `handleDragStart`. On release, calls
  `onDrop(sourceKey, target, rows)`; `ProjectItem` runs `applyDrop` and
  `applySidebarChange`.

`useWorkspaceDrag.ts` and `WorkspaceList.tsx` are deleted. `useListDrag.ts`
is untouched (used by project settings).

### UI

- `ProjectItem` renders `buildSidebarItems(project)` in one column: a
  workspace row, or a `FolderItem` block. Workspace rows register in
  `rowRefs` by path; `FolderItem` registers its block and header by folder id.
- `FolderItem` gains `dropTarget: boolean` (adds `styles.folderDropTarget`:
  accent outline and background) and `onDragStart` on its header. Header
  click toggles collapse only when `justDragged` is false, matching
  workspaces.
- Context-menu actions stay and now route through the pure placement helpers
  so a menu move lands in the same place a drop would.
- The project header's `New Folder…` appends at the end.

## Consequences

**Better**

- Folders and workspaces are one draggable list. `local` on top, a folder,
  then loose branches is now expressible, and folders can be reordered.
- Drop onto a header or between members moves a workspace into a folder in
  one gesture. Dragging above a folder or below a collapsed one pulls it out.
- All placement logic is pure and unit tested; the hook only measures and
  translates pointer geometry into a `DropTarget`.
- Persisted data stays backward compatible. An ADR-166 `projects.json` loads
  unchanged: normalization appends folder ids after workspaces, which renders
  exactly the old layout.

**Harder / tradeoffs**

- Dropping *after the last member* of an expanded folder lands inside the
  folder. To place a row loose directly after an expanded folder, drop before
  the next top-level item, or collapse the folder first. This is the standard
  tree-view compromise and avoids an X-offset heuristic.
- Dragging a folder moves a variable-height block. The shift animation still
  works because the block is one row for that drag, but tall folders shove a
  lot of pixels around.
- `useWorkspaceDrag` is rewritten rather than extended: the index-based
  contract cannot express nesting. Two files are deleted.
- Two IPC round-trips per drop that changes membership. Acceptable: both are
  synchronous JSON writes in main, and the renderer updates optimistically.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
