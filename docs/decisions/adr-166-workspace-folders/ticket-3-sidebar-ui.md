---
title: Sidebar folder rows, move-to-folder menus, and per-section drag
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# Sidebar folder rows, move-to-folder menus, and per-section drag

Render folders in `ProjectItem`, add the context-menu surface for creating,
renaming, deleting, and moving into folders, and make drag reorder work per
section. Read `docs/decisions/adr-166-workspace-folders/index.md` first.

Rules: use `<Button>` / `<Input>` from `src/components/ui/` for any new
interactive element (see `.claude/rules/ui-components.md`). Never mutate
`project.workspaces` order semantics — `selectedWorkspaceIndex`,
`onSelectWorkspace`, `onHideWorkspace`, and `onOpenDiff` all take the
**global** index into `project.workspaces`.

## 1. `WorkspaceList` (new: `src/components/sidebar/WorkspaceList.tsx`)

Owns one `useWorkspaceDrag` for one section.

```ts
interface WorkspaceDragProps {
  idx: number;                       // section-local
  isDragging: boolean;
  getTransformStyle: (idx: number) => React.CSSProperties | undefined;
  justDragged: React.RefObject<boolean>;
  itemRefCallback: (el: HTMLDivElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
}
interface WorkspaceListProps {
  workspaces: WorkspaceInfo[];       // visible members of this section
  editingPath: string | null;
  onReorder: (sectionPaths: string[]) => void;
  renderWorkspace: (ws: WorkspaceInfo, drag: WorkspaceDragProps) => React.ReactNode;
  className?: string;
}
```

Renders `<div className={styles.workspaces}>` and maps `workspaces` through
`renderWorkspace`. `useWorkspaceDrag` is unchanged — pass the section array
as `workspaces` and `onReorder` as `onReorderWorkspaces`.

## 2. `FolderItem` (new: `src/components/sidebar/FolderItem.tsx`)

Props: `projectId`, `folder`, `workspaces` (members), `collapsed`,
`containsSelected: boolean`, `onToggleCollapsed`, `onRename(name)`,
`onDelete()`, `children` (the `WorkspaceList` for the body).

- Header row: `ChevronRight` (rotates like `projectChevron`), a
  `lucide-react` `Folder` icon, name, dim member count, and when collapsed an
  `<AgentDot>` from `useWorkspacesAgentStatus(workspaces)` (see §5).
  Click toggles collapse. Add `styles.folderActive` when `containsSelected`
  and collapsed so the user can see where the active workspace went.
- Inline rename: double-click or context-menu *Rename Folder* swaps the name
  for an `<input className={styles.workspaceNameInput}>`; Enter/blur commit
  (trimmed, non-empty), Escape cancels. Stop pointer propagation on the input.
- Radix `ContextMenu` with *Rename Folder* and *Delete Folder* (danger
  style). Delete calls `onDelete` directly — nothing is destroyed, members
  become loose.
- Body: render `children` only when `!collapsed`, wrapped in
  `styles.folderBody` (left padding ~12px so members read as nested).

## 3. `NewFolderDialog` (new: `src/components/sidebar/NewFolderDialog.tsx`)

Radix dialog styled with `dialogs.module.css` like
`ConvertToWorkspaceDialog`: title "New Folder", one `<Input placeholder="Folder name">`
autofocused, Cancel / Create buttons. `onConfirm(name)` only when trimmed
name is non-empty; Enter in the input submits. Reset the input when `open`
flips to true.

## 4. `ProjectItem.tsx` changes

- Compute `const grouped = useMemo(() => groupWorkspaces(project), [project.workspaces, project.folders])`.
- Replace the direct `project.workspaces.map(...)` with:
  1. `<WorkspaceList workspaces={grouped.loose} …>` (only if non-empty),
  2. one `<FolderItem>` per `grouped.folders` entry, each wrapping its own
     `<WorkspaceList>`.
- Move the existing per-workspace body (the `WorkspaceItem` + its
  `ContextMenu.Root`) into a `renderWorkspace(ws, drag)` callback defined
  once in `ProjectItem`. Inside it, `const globalIdx = project.workspaces.indexOf(ws)`
  and use `globalIdx` for `idx`/`selectedWorkspaceIndex` comparison,
  `onSelectWorkspace`, `onHideWorkspace`, `onOpenDiff`. Use `drag.idx` for
  `getTransformStyle`, `itemRefCallback`, `onPointerDown`, `isDragging`.
  `WorkspaceItem` compares `idx === selectedWorkspaceIndex` for the active
  style — pass `globalIdx` as `idx` and pass `drag.getTransformStyle` wrapped
  so it is called with `drag.idx`: `getTransformStyle={() => drag.getTransformStyle(drag.idx)}`.
- Section `onReorder`: `onReorderWorkspaces(mergeSectionOrder(project.workspaces.map(w => w.path), sectionPaths))`.
- Workspace context menu additions (before the `!ws.isMain` block, applies to
  every workspace):
  - `ContextMenu.Sub` *Move to Folder* listing `project.folders`; the current
    folder gets a `Check` icon and is disabled. Then a separator and
    *New Folder…* (opens `NewFolderDialog` with `pendingMovePath = ws.path`).
  - When `ws.folderId` is set: *Remove from Folder*.
- Project header context menu: add *New Folder…* after *New Workspace*
  (opens `NewFolderDialog` with no pending path).
- Dialog confirm: `const folder = await createWorkspaceFolder(project.id, name)`;
  if `folder && pendingMovePath`, `setWorkspaceFolder(project.id, pendingMovePath, folder.id)`.
- Read the store actions and `collapsedFolderKeys` via `useProjectStore`
  directly inside `ProjectItem` (do not thread more props through
  `Sidebar.tsx`); `Sidebar.tsx` needs no change.
- `containsSelected` for a folder = `grouped` folder members include
  `project.workspaces[project.selectedWorkspaceIndex]` and `isSelected`.

## 5. Agent status hook

In `src/hooks/useProjectAgentStatus.ts`, extract the body into
`export function useWorkspacesAgentStatus(workspaces: WorkspaceInfo[])` and
make `useProjectAgentStatus(project)` call it with `project.workspaces`.
Dependency array uses `workspaces`.

## 6. CSS (`src/components/sidebar/ProjectItem.module.css`)

Add: `.folder`, `.folderHeader` (flex row, 4px 6px padding, 12px font,
hover `var(--surface)`), `.folderChevron` / `.folderChevronOpen` (reuse the
chevron values), `.folderIcon` (dim), `.folderName` (ellipsis), `.folderCount`
(dim, 10px, tabular-nums), `.folderActive` (color `var(--project-color,
var(--accent))`), `.folderBody` (padding-left 12px, margin-top 6px). Keep
`.workspaces` as is so loose workspaces look unchanged.

## 7. Verify

- `pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec tsc --noEmit -p tsconfig.electron.json`, `pnpm lint`, `pnpm test:unit` (check `package.json`
  for exact script names).
- Manually reason through: drag inside a folder does not disturb loose order;
  hiding a grouped workspace removes it from the folder view but keeps
  membership; selecting a workspace inside a collapsed folder expands it.

## Files to touch
- `src/components/sidebar/WorkspaceList.tsx` — new section component owning drag
- `src/components/sidebar/FolderItem.tsx` — new folder header + body + context menu
- `src/components/sidebar/NewFolderDialog.tsx` — new dialog
- `src/components/sidebar/ProjectItem.tsx` — grouping, renderWorkspace, menus, dialog wiring
- `src/components/sidebar/ProjectItem.module.css` — folder styles
- `src/hooks/useProjectAgentStatus.ts` — extract `useWorkspacesAgentStatus`
