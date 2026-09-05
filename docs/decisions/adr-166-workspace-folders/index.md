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

# ADR-166: Workspace folders

Closes #178.

## Context

A project in the sidebar renders its workspaces as one flat, drag-orderable
list (`src/components/sidebar/ProjectItem.tsx`). Projects with many worktrees
— one per issue, a few long-lived experiments, a release branch — become a
wall of near-identical rows. The only tools for taming it today are
reordering (`workspaceOrder`) and hiding (`workspaceHidden`), and hiding
removes the workspace from view entirely.

Issue #178 asks for optional folders: group workspaces within a project, and
collapse/expand each group.

What exists that this builds on:

- **Per-workspace metadata maps** in `electron/persistence.ts`
  (`PersistedProject`): `workspaceNames`, `workspaceOrder`,
  `workspaceIssues`, `workspaceHidden`, all keyed by workspace path and
  overlaid onto the live `git worktree list` in `buildProjectInfo()`.
  `removeWorktree()` deletes the entries for the removed path.
- **Collapse state for projects** lives renderer-side only:
  `collapsedProjectIds` in `src/store/project-store.ts`, persisted to
  `localStorage` under `manor:collapsedProjectIds`. Selecting a project calls
  `setProjectExpanded` so the active item is never hidden inside a collapsed
  header.
- **Drag reorder** is `src/hooks/useWorkspaceDrag.ts`. It assumes the items
  it manages are the *entire* `project.workspaces` array: indices passed to
  `handleDragStart`/`getTransformStyle` are global indices, and the drop
  handler splices a full `orderedPaths` list.
- **Aggregate agent status** for a collapsed project comes from
  `src/hooks/useProjectAgentStatus.ts`, which iterates
  `project.workspaces`.
- **IPC shape**: `electron/ipc/projects.ts` → `electron/preload.ts` →
  `src/electron.d.ts` → store action, one channel per mutation. Hidden and
  rename are the closest analogues.

## Decision

Folders are project-scoped, flat (no nesting), and purely presentational: a
folder never changes where a worktree lives on disk or how git sees it.

### Data model (main process)

In `electron/persistence.ts`:

```ts
export interface WorkspaceFolder { id: string; name: string }

// PersistedProject
workspaceFolders?: WorkspaceFolder[];             // ordered; creation order
workspaceFolderIds?: Record<string, string>;      // workspace path → folder id

// ProjectInfo
folders: WorkspaceFolder[];

// WorkspaceInfo
folderId?: string | null;
```

Membership is a per-path map, the same shape as `workspaceHidden`, so it
composes with the existing overlay and cleanup code. `buildProjectInfo()`
resolves `folderId` per workspace and drops any membership that points at a
folder id that no longer exists (dangling ids resolve to `null`).
`removeWorktree()` deletes the path from `workspaceFolderIds`.

New `ProjectManager` methods, each calling `saveState()`:

- `createWorkspaceFolder(projectId, name): WorkspaceFolder | null` — trims the
  name, rejects empty, generates `crypto.randomUUID()`.
- `renameWorkspaceFolder(projectId, folderId, name): void` — trims, ignores
  empty.
- `deleteWorkspaceFolder(projectId, folderId): void` — removes the folder and
  every membership pointing at it. Workspaces are ungrouped, never deleted.
- `setWorkspaceFolder(projectId, workspacePath, folderId | null): void` —
  `null` or an unknown id removes the membership.

### IPC

Four channels in `electron/ipc/projects.ts`, mirrored in `preload.ts` and
`src/electron.d.ts`:

| channel | args | returns |
| --- | --- | --- |
| `projects:createWorkspaceFolder` | projectId, name | `WorkspaceFolder \| null` |
| `projects:renameWorkspaceFolder` | projectId, folderId, name | void |
| `projects:deleteWorkspaceFolder` | projectId, folderId | void |
| `projects:setWorkspaceFolder` | projectId, workspacePath, folderId \| null | void |

`assertString` guards `name` on create/rename. `formatWorkspace` in
`electron/mcp/tools-projects.ts` appends ` [folder: <name>]` when a workspace
is grouped so MCP callers can see the grouping; no MCP tool *mutates* folders
in this ADR.

### Renderer store

`src/store/project-store.ts` mirrors the types and adds optimistic actions
matching `setWorkspaceHidden`'s pattern (update local state, then invoke IPC;
`createWorkspaceFolder` awaits IPC because it needs the generated id).

Collapse state follows the project precedent exactly: `collapsedFolderKeys:
Set<string>` keyed `${projectId}/${folderId}`, persisted to `localStorage`
under `manor:collapsedWorkspaceFolderKeys`, with `toggleFolderCollapsed` and
`setFolderExpanded`. `selectWorkspace` calls `setFolderExpanded` for the
selected workspace's folder so the active row is never hidden by a collapsed
folder — the same guarantee projects already have.

### Grouping and ordering

A pure module `src/utils/workspace-folders.ts` owns the derived shape:

- `groupWorkspaces(project)` → `{ loose: WorkspaceInfo[]; folders: { folder:
  WorkspaceFolder; workspaces: WorkspaceInfo[] }[] }`. Hidden workspaces are
  excluded from both. Within a section, workspaces keep their
  `project.workspaces` order. Loose workspaces render first, then folders in
  `project.folders` order, so the `local` workspace stays at the top of an
  untouched project.
- `mergeSectionOrder(allPaths, sectionPaths)` → `string[]`. Given the full
  project order and a reordered subset, returns the full order with the
  subset's slots rewritten in the new sequence. This is how a drag inside one
  section produces the `orderedPaths` that `reorderWorkspaces` already
  expects, without touching other sections.

Both are unit tested.

### UI

`ProjectItem.tsx` stops mapping `project.workspaces` directly. Rendering
splits into:

- **`WorkspaceList`** (new, `src/components/sidebar/WorkspaceList.tsx`): owns
  one `useWorkspaceDrag` instance for one section. Props: the section's
  `workspaces`, `editingPath`, `onReorder(sectionPaths)`, and a
  `renderWorkspace(ws, drag)` callback where `drag` carries the section-local
  index, `isDragging`, `getTransformStyle`, `justDragged`, `itemRefCallback`,
  and `onPointerDown`. `useWorkspaceDrag` itself is unchanged; it simply
  receives a shorter array. Drag is therefore **within a section only** —
  moving between folders is a context-menu action, not a drop target.
- **`FolderItem`** (new, `src/components/sidebar/FolderItem.tsx`): header row
  with chevron, name, member count, and an `AgentDot` when collapsed
  (aggregate of its members). Click toggles collapse. Double-click or context
  menu → inline rename (reusing the `workspaceNameInput` style). Context menu:
  *Rename Folder*, *Delete Folder* (ungroups members; no confirmation needed
  since nothing is destroyed). Body is a `WorkspaceList` when expanded.
- **`ProjectItem`** keeps every existing concern — per-workspace context
  menu, rename state, dialogs, `onSelectWorkspace(globalIdx)` — and passes
  them through `renderWorkspace`. Global index is recovered with
  `project.workspaces.indexOf(ws)`. `onReorder` from a section goes through
  `mergeSectionOrder` before calling `onReorderWorkspaces`.
- **Workspace context menu** gains a *Move to Folder ▸* submenu listing each
  folder (current one marked), *New Folder…*, and — when grouped — *Remove
  from Folder*. Available for every workspace including `local`.
- **Project header context menu** gains *New Folder…*.
- **`NewFolderDialog`** (new): a Radix dialog with one `Input`, styled from
  `dialogs.module.css` like `ConvertToWorkspaceDialog`. Optionally receives a
  workspace path so "New Folder…" from a workspace's menu creates the folder
  and moves that workspace into it in one step.
- **Agent status**: `useProjectAgentStatus` is refactored into
  `useWorkspacesAgentStatus(workspaces)` with the project variant kept as a
  thin wrapper, so a collapsed folder can show the same dot a collapsed
  project does.

Folder rows and their member rows share `ProjectItem.module.css`; members are
indented under the folder header.

## Consequences

**Better**

- Large projects become navigable without hiding anything. Collapse state
  survives restarts, like project collapse does.
- Zero risk to git state: folders are metadata overlaid in
  `buildProjectInfo()`, identical in kind to names and hidden flags. A
  corrupted or missing `workspaceFolders` entry degrades to "no folders".
- `useWorkspaceDrag` is reused unchanged; the only new ordering logic is the
  pure `mergeSectionOrder`, which is trivially testable.
- MCP output reflects grouping, so agents reading `list_workspaces` see the
  same structure the user does.

**Harder / tradeoffs**

- No drag-and-drop between sections. Moving a workspace is a two-click
  context-menu action. A drop-target design would require rewriting the drag
  hook's index math and is deferred until the simple version proves out.
- Folders cannot be reordered relative to each other or nested. Creation
  order is the folder order. Both are natural follow-ups if requested.
- `ProjectItem.tsx` was already 600 lines; splitting out `WorkspaceList` and
  `FolderItem` keeps it from growing, but the `renderWorkspace` callback adds
  one level of indirection to the hot path of the sidebar.
- `selectedWorkspaceIndex` remains a global index into `project.workspaces`.
  Every existing caller keeps working, but the UI must be careful to pass
  global — not section-local — indices to `onSelectWorkspace`,
  `onHideWorkspace`, and `onOpenDiff`.
- Collapse keys are renderer-local (`localStorage`), so they do not sync to a
  detached window or another machine. That matches the existing project
  collapse behaviour.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
