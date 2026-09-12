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

# ADR-172: Sidenav UX — nested folders, keyboard rename, honest PR badges

Extends ADR-166 (workspace folders) and ADR-167 (unified sidebar order,
drag-into-folder, PR readiness badge).

## Context

Five gaps surfaced from using the sidebar day to day. Three of them are
sidebar behaviour, two are the PR badge.

### 1. Renaming is mouse-only

A rename starts on double-click (`ProjectItem.tsx` `onDoubleClick`,
`FolderItem.tsx` `onDoubleClick`) or from the context menu. There is no
keyboard path: sidebar rows are plain `<div>`s with no `tabIndex`, so nothing
in the sidebar can hold focus and no key can act on "the row I am looking at".

The reason no row holds focus today is that `useTerminalLifecycle.ts` focuses
the pane's xterm whenever it becomes the focused pane of the active tab.
Clicking a *different* workspace in the sidebar switches workspaces, which
flips that selector, and the terminal takes focus back. Any Enter-to-rename
that relies on DOM focus has to reckon with that effect.

### 2. Folders cannot nest

`WorkspaceFolder` is `{ id, name }` and membership is a flat
`workspaceFolderIds: Record<path, folderId>`. A folder can hold workspaces
and nothing else. Once a project has a dozen branches grouped into five or
six folders, the sidebar is flat again at the folder level — there is no way
to group the folders themselves (`epic/` holding `epic/api`, `epic/ui`).

The ordering machinery does not stand in the way: `sidebarOrder` is already
one flat array of workspace paths *and* folder ids (ADR-167), and it carries
position only — structure comes from `workspaceFolderIds`. Adding a
`parentId` to the folder record extends that same split (order in the array,
structure in the links) to folders.

### 3. Right-clicking a rename input closes it

Every workspace row and every folder header is wrapped in a
`ContextMenu.Trigger`. While the inline rename `<input>` is open, a
right-click inside that input still opens the row's context menu, which takes
focus, which fires the input's `onBlur`, which commits and closes the rename.
Right-clicking a text field to reach Cut/Copy/Paste is the one gesture that
must not destroy the edit.

### 4. The badge and the popover disagree about "pending"

For a PR with CI still running, the badge draws a spinning yellow
`LoaderCircle` (`badgeIcon()` default branch) while the popover's summary row
for the same fact draws a static `Clock`. Two icons, one state. The spinner is
also the *agent* spinner — a yellow spinning ring in the sidebar means "an
agent is working" everywhere else in the app — so a PR waiting on CI reads as
an agent that never finishes.

### 5. "Review required" has no badge state

`prReadiness()` returns `pending` for an open, non-draft PR with green CI, no
unresolved threads and `reviewDecision === "REVIEW_REQUIRED"`. `pending` draws
the neutral grey `GitPullRequest` badge — the same badge as a draft that has
not been looked at. The popover says "Review required" in yellow right next
to it. The badge is answering "can this ship?" with a shrug when it knows the
answer is "no — it needs a reviewer".

## Decision

### A. Nested folders

`WorkspaceFolder` gains `parentId: string | null`:

```ts
export interface WorkspaceFolder {
  id: string;
  name: string;
  /** Enclosing folder, or null at the top level. */
  parentId: string | null;
}
```

Persisted as an optional field — an ADR-167 `projects.json` loads with every
folder at the top level, which is exactly today's layout. Structure lives in
the links (`parentId` for folders, `workspaceFolderIds` for workspaces),
position lives in `sidebarOrder`, and `normalizeSidebarOrder` is unchanged:
the array stays a flat list of keys.

**Main process** (`electron/persistence.ts`):

- `createWorkspaceFolder(projectId, name, parentId?)` — validates that
  `parentId` names an existing folder in the project; unknown ids are stored
  as `null` rather than rejected, matching how `setWorkspaceFolder` already
  treats dangling ids.
- `setFolderParent(projectId, folderId, parentId)` — new. Rejects a cycle
  (`parentId` equal to `folderId` or any descendant of it) by leaving the
  state untouched and returning `false`. Cycle detection is a pure exported
  helper, `isFolderDescendant(folders, folderId, candidateAncestorId)`.
- `deleteWorkspaceFolder` **promotes** rather than orphans: child folders get
  the deleted folder's `parentId`, member workspaces get the deleted folder's
  `parentId` as their `workspaceFolderIds` entry (or lose the entry at the top
  level). `spliceFolderOut` keeps splicing the deleted id's slot, now with
  child folder ids alongside member paths in their current relative order.
- `buildProjectInfo` passes `parentId` through, normalizing a dangling or
  self-referential parent to `null`.

New route `POST /projects/:projectId/folders/:folderId/parent`
(`electron/routes/folders.ts`), matching IPC `projects:setFolderParent`,
preload binding and `src/electron.d.ts` entry. `POST .../folders` accepts an
optional `parentId`. The MCP `create_folder` tool takes an optional
`parentId`, `list_folders` reports it, and a `move_folder` tool wraps
`setFolderParent` so the CLI can nest as well.

**View model** (`src/utils/sidebar-items.ts`): the folder item holds children
rather than workspaces.

```ts
export type SidebarItem =
  | { kind: "workspace"; ws: WorkspaceInfo }
  | { kind: "folder"; folder: WorkspaceFolder; children: SidebarItem[] };
```

- `buildSidebarItems` walks `sidebarOrder` recursively: a folder's children
  are the workspaces pointing at it and the folders whose `parentId` is it,
  ordered by their index in `sidebarOrder`. Entries whose parent chain does
  not resolve are emitted at the top level (the existing defensive tail).
- `Row` gains `depth: number`; `flattenRows` recurses, and a *folder* drag now
  emits rows for other folders' headers too (so a folder can be dropped into a
  folder) while skipping the dragged folder's own subtree.
- `applyDrop` gains one rule and keeps the rest: a folder may not be dropped
  into itself or a descendant — that drop is a no-op. `{ type: "into" }` now
  accepts a folder source.
- `serializeOrder` emits depth-first: folder id, then its children in order,
  recursively.
- `membershipOf` keeps returning workspace → folder id, and a new
  `folderParentsOf(items)` returns folder id → parent id, so the store can
  diff both.
- `placeInFolder`, `placeAfterFolder` and `insertFolderBefore` take
  folder-or-workspace keys instead of paths only.
- `descendantWorkspaces(item)` gives a folder's whole subtree of workspaces,
  which is what the header's count and aggregate agent dot report.

**Store** (`src/store/project-store.ts`): `applySidebarChange` diffs folder
parents as well as workspace membership and issues
`projects:setFolderParent` for each change. `createWorkspaceFolder` takes an
optional `parentId`. `deleteWorkspaceFolder`'s optimistic update mirrors
main's promotion rule.

**UI**: `ProjectItem` renders `item.children` recursively through the same
`FolderItem`; `FolderItem` takes `depth` and indents its body (indent capped
past depth 4 so deep trees keep their labels readable), and its context menu
gains **New Folder Inside…**. The workspace "Move to Folder" submenu lists
every folder by its full path (`epic / api`). Dragging is unchanged in feel:
a folder header is an "into" target for workspaces *and* folders.

### B. Enter renames, and the sidebar may hold focus

Rows become focusable: `tabIndex={0}` plus `data-sidebar-row` on each
workspace row and folder header, with a `:focus-visible` ring in
`ProjectItem.module.css`. On a focused row:

- **Enter** starts the inline rename (the workspace's, or the folder's).
- **↑ / ↓** move focus to the previous/next `[data-sidebar-row]` in DOM order,
  across folders and projects.
- **← / →** collapse/expand a focused folder header.
- **Escape** hands focus back to the active pane.

Double-click no longer starts a rename; the handlers come off both the
workspace row and the folder header. Rename stays reachable from the context
menu and the app menu.

For the row to keep focus, `useTerminalLifecycle`'s auto-focus effect stops
stealing it: when `document.activeElement` sits inside `[data-sidebar-row]`,
the effect skips `term.focus()`. Escape (and the existing click-into-pane
path) still gets the terminal back, via a new `refocusActivePane()` action on
`app-store` that bumps a `paneFocusNonce` the effect also depends on — an
explicit "focus the terminal now" that overrides the sidebar guard.

The trade-off this accepts, deliberately: clicking a workspace in the sidebar
no longer lands the caret in that workspace's terminal. Typing needs a click
into the pane or an Escape first.

### C. Right-click must not close a rename

`ContextMenu.Trigger` takes `disabled={isEditing}` on the workspace row and on
the folder header. While an inline rename is open, right-clicking the input
falls through to the OS text-field menu instead of the app's row menu, so the
edit survives.

### D. One pending icon, quieter

`badgeIcon()`'s pending branch returns `Clock` with `spin: false` — the same
icon the popover's summary row already uses for the same fact. Its tone is a
new `.prIconPending`, yellow mixed toward `--text-dim`, so the badge reads as
"waiting" without competing with the agent spinner. The merge-queue spinner
(`queued`) keeps spinning: it is accent-coloured, not yellow, and a merge
queue really is a machine working.

### E. `review` is a readiness state

`PrReadiness` gains `"review"`, evaluated after `queued` and before `ready`:

```
merged → closed → blocked → queued → review → ready → pending
```

A PR is `review` when it is open, not a draft, CI is clear, there are no
unresolved threads, and `reviewDecision === "REVIEW_REQUIRED"` — exactly the
case where the only thing left is a human. The badge draws `ShieldQuestion`
(the popover's own "Review required" icon) on a soft yellow tint, distinct
from `blocked`'s heavier yellow. Everything else about the badge is unchanged.

## Consequences

**Better**

- Folders nest, so a project with many groups can be organised at more than
  one level, by drag or by menu, with the same gestures as today.
- Rename is reachable from the keyboard, and the sidebar is arrow-navigable —
  the first keyboard affordance the sidebar has had.
- Right-clicking a rename input does the obvious thing.
- The badge and the popover tell the same story about CI, in a register that
  no longer collides with the agent spinner.
- A PR waiting on a reviewer says so at a glance.

**Harder / tradeoffs**

- **Clicking a sidebar workspace no longer focuses its terminal.** This is the
  biggest behavioural change in the ADR and it touches muscle memory. Escape
  from the row, or a click in the pane, restores the old feel.
- **Double-click no longer renames.** Anyone who learned that gesture has to
  learn Enter or the context menu.
- `SidebarItem`'s folder arm changes shape (`workspaces` → `children`), which
  ripples through `menu-handlers.ts`, `useMenuContextSync.ts`, the store and
  the whole of `sidebar-items.test.ts`.
- Nesting adds a cycle to guard against, in two places (main rejects, the
  renderer refuses the drop). Both are covered by unit tests, but it is a new
  class of invalid state that flat folders could not reach.
- A deep tree eats horizontal space in a sidebar that is 160–400px wide. The
  indent is capped, which means depth stops being visually distinguishable
  past four levels.
- `deleteWorkspaceFolder` gets a real policy (promote children to the
  grandparent) where it used to just null out membership.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
