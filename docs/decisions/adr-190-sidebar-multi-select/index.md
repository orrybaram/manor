---
type: adr
status: proposed
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

# ADR-190: Multi-select workspaces in the sidebar

## Context

Every workspace action in the sidebar (delete, hide, move to folder, drag into/out of a folder) addresses exactly one row. Cleaning up after a batch of agent workspaces (`manor batch-create-workspaces`), or grouping several of them into a folder, means repeating the same context-menu walk once per workspace. Users expect the file-manager idiom: shift-click to select a range, then act on the selection from the context menu or by dragging it.

Relevant existing pieces:

- `src/components/sidebar/ProjectItem.tsx` renders each project's tree (`buildSidebarItems`) and owns the per-workspace context menu, the delete/merge dialogs and the drag (`useSidebarDrag`).
- `src/utils/sidebar-items.ts` is the pure tree model: `applyDrop`, `placeInFolder`, `placeAfterFolder`, `insertFolderBefore`, `flattenRows`. The store persists any tree via `applySidebarChange` (membership, folder parents, then order).
- `src/hooks/useSidebarDrag.ts` measures rows and turns the pointer into a `DropTarget` for one `sourceKey`.
- `src/store/workspace-actions.ts` has `removeWorktreeWithToast` and `hideWorkspaceAndNavigate`, both single-workspace and fire-and-forget.

## Decision

### 1. Selection model

- A new zustand store `src/store/sidebar-selection-store.ts` holds `{ projectId: string | null; paths: Set<string>; anchorPath: string | null }` with `select`, `toggle`, `selectRange`, `clear`, `prune`.
- Selection is **per project**. Folders are per project, so a cross-project selection would have no valid bulk "Move to Folder" or drag. Selecting in a different project replaces the selection.
- Only **workspace rows** are selectable. Folder rows are not; the main (local) workspace is selectable (it can be moved to a folder), but bulk hide and delete skip it.
- Gestures on a workspace row:
  - **Plain click**: behaves as today (opens the workspace), clears the selection, and sets the anchor to that row.
  - **Shift+click**: selects the contiguous range of *visible* workspace rows (tree order, skipping collapsed folders' contents) from the anchor to the clicked row. It does not navigate. If there is no anchor in this project, the anchor is the active workspace; failing that, the clicked row.
  - **Cmd/Ctrl+click**: toggles one row and moves the anchor, without navigating. This is the standard companion to shift-click and costs almost nothing.
  - **Escape** (row focused) and a click on empty sidebar space clear the selection. Escape keeps its existing "refocus pane" behaviour after clearing.
- Selected rows get a `.workspaceSelected` style: an accent-tinted background, distinct from `.workspaceActive`.
- Paths that disappear from the project are pruned from the selection on workspace change.
- Range order comes from a new pure helper `visibleWorkspacePaths(items, collapsedFolderIds)` in `sidebar-items.ts`.

### 2. Bulk context menu

Right-clicking a row that is part of a selection of 2+ opens a **bulk menu** instead of the single-workspace menu. Right-clicking an unselected row clears the selection and shows the normal menu. The bulk menu has:

- a disabled label, "N workspaces selected"
- **Move to Folder ▸**: the same folder choices plus "New Folder…". A new folder takes the slot of the first selected row and receives every selected workspace.
- **Remove from Folder**: shown when any selected workspace is in a folder. Each one leaves its own folder (`placeAfterFolder` semantics).
- **Hide N Workspaces**: excludes main.
- **Delete N Workspaces…** (danger): excludes main. Opens a new `BulkDeleteWorktreesDialog` that lists the names and has the same "Also delete local branches" checkbox, backed by the same `localStorage` key.

The selection clears after any bulk action.

Pure helpers in `sidebar-items.ts`: `placeManyInFolder(items, keys, folderId)` and `placeManyAfterFolders(items, keys)`. The store gains an optional `anchorKeys?: string[]` path in `createWorkspaceFolder`, or a sibling `createWorkspaceFolderWith(projectId, name, keys, parentId)`, whichever reads cleaner.

Bulk hide and delete live in `workspace-actions.ts` as `hideWorkspacesAndNavigate(projectId, paths)` and `removeWorktreesWithToast(project, workspaces, deleteBranch)`:

- If the active workspace is in the set, first navigate to the first remaining workspace (main when present). The per-item "select next" logic must not land on another row that is about to go.
- Removals run **sequentially**. Concurrent `git worktree remove` calls on one repo risk lock contention, so `removeWorktreeWithToast` is refactored to return its promise. It shows one toast per workspace, as today.
- Hides are awaited sequentially.

### 3. Multi-drag

When a drag starts on a row that belongs to a selection of 2+, the whole selection moves:

- `useSidebarDrag` takes an optional `groupKeys: string[]` (the selection, in tree order) and passes it through to `onDrop(sourceKey, target, rows, groupKeys)`. The pointer math is unchanged: the grabbed row drives the drop target.
- The other selected rows render dimmed (reuse `.workspaceDragging` opacity) while the drag is live. The grabbed row shows a small count badge ("3").
- A new pure `applyGroupDrop(items, sourceKey, groupKeys, target, rows)` in `sidebar-items.ts`:
  - `into` → `placeManyInFolder` in tree order.
  - `slot` → resolve the landing position against `rows` minus the source. If the predecessor row is itself in the group, walk back to the nearest non-group row. Then remove all group items, and insert them as one contiguous block in tree order at that position, with the same parent rules as `applyDrop`.
  - A group of one delegates to `applyDrop` exactly.
- Dragging a group out of a folder is just a slot drop outside it, and needs no special case.
- Shift/Cmd-pointerdown must not start a drag. Those gestures are selection clicks.

## Consequences

- **Better**: batch cleanup and grouping become a couple of gestures. All tree mutations stay in the pure, tested `sidebar-items.ts`, and the store's `applySidebarChange` persists a group move in one pass.
- **Harder**: `ProjectItem.tsx`, already over 1000 lines, grows a second context menu. The bulk menu goes in its own component (`WorkspaceBulkMenu.tsx`) to contain that. The drag hook gains a parameter that it only forwards.
- **Risks**:
  - Sequential deletes of many worktrees are slow, but each has its own progress toast.
  - A shift-click that navigates by accident would be jarring, so modifier clicks explicitly skip `onSelectWorkspace`.
  - The selection is not keyboard-extendable (Shift+Arrow) in this ADR. That is a natural follow-up on top of the ADR-175 roving rows.
  - Selection state is global and ephemeral (not persisted), and it survives collapsing a project. Collapsed rows are simply not visible, which is acceptable.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
