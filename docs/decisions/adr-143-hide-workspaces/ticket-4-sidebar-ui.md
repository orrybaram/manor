---
title: Sidebar hide/unhide UI (filter, menu item, unhide submenu, auto-switch)
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Sidebar hide/unhide UI

Wire the hide/unhide UX into the sidebar. Four sub-parts. Read
`src/components/sidebar/ProjectItem.tsx` fully first.

## 1. Hide hidden workspaces from the rendered list — preserve indices

In `ProjectItem.tsx`, the workspace list is rendered by
`project.workspaces.map((ws, idx) => { ... })` (around line 332).

**Do NOT filter the array** — `idx` is the index used for
`selectedWorkspaceIndex` highlighting, `onSelectWorkspace(idx)`, drag refs
(`itemRefs`), and `getTransformStyle(idx)`. Filtering would shift indices and
break selection/drag. Instead **skip in place** at the top of the map callback:

```tsx
project.workspaces.map((ws, idx) => {
  if (ws.hidden) return null;
  // ...unchanged...
})
```

`useWorkspaceDrag` keeps receiving the full `project.workspaces` array, so
`workspaceOrder` semantics are untouched and hidden workspaces keep their slot
in the order for when they're unhidden.

## 2. "Hide Workspace" item in the workspace context menu

In the worktree-only section of the workspace context menu (the `{!ws.isMain &&
(...)}` block, around lines 446–480, next to "Rename Workspace"), add a plain
(NOT `contextMenuItemDanger`) item:

```tsx
<ContextMenu.Item
  className={styles.contextMenuItem}
  onSelect={() => onHideWorkspace(ws, idx)}
>
  Hide Workspace
</ContextMenu.Item>
```

Add a new prop `onHideWorkspace: (ws: WorkspaceInfo, idx: number) => void` to
`ProjectItemProps`.

## 3. Auto-switch when hiding the currently-selected workspace

The hide handler must call the store action AND, if the hidden workspace is the
one currently selected, switch the project's selection back to its main/local
workspace so the panes don't keep showing a now-hidden workspace.

Implement in the `onHideWorkspace` handler (wired in `Sidebar.tsx`, see part 4):

```ts
const onHideWorkspace = (project, ws, idx) => {
  const wasSelected = idx === project.selectedWorkspaceIndex;
  setWorkspaceHidden(project.id, ws.path, true);
  if (wasSelected) {
    const mainIndex = project.workspaces.findIndex((w) => w.isMain);
    if (mainIndex >= 0) selectWorkspace(project.id, mainIndex);
  }
};
```

(`selectWorkspace` already updates `selectedWorkspaceIndex` and calls
`setActiveWorkspace` to switch the panes — see project-store.ts ~line 360.)

## 4. "Hidden workspaces (N)" unhide submenu on the project header menu

In the **project header** context menu (`ProjectItem.tsx` lines ~306–328, which
has "New Workspace", "Project Settings", separator, "Remove Project"), insert a
submenu **after "Project Settings"** and **before** the separator/"Remove
Project". Render it only when there is at least one hidden workspace.

```tsx
const hiddenWorkspaces = project.workspaces.filter((ws) => ws.hidden);
// ...
{hiddenWorkspaces.length > 0 && (
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger className={styles.contextMenuItem}>
      Hidden workspaces ({hiddenWorkspaces.length})
    </ContextMenu.SubTrigger>
    <ContextMenu.Portal>
      <ContextMenu.SubContent className={styles.contextMenu}>
        {hiddenWorkspaces.map((ws) => (
          <ContextMenu.Item
            key={ws.path}
            className={styles.contextMenuItem}
            onSelect={() => onUnhideWorkspace(ws)}
          >
            {ws.name || ws.branch || ws.path}
          </ContextMenu.Item>
        ))}
      </ContextMenu.SubContent>
    </ContextMenu.Portal>
  </ContextMenu.Sub>
)}
```

`onUnhideWorkspace(ws)` simply calls `setWorkspaceHidden(project.id, ws.path,
false)`. Check `ProjectItem.module.css` for an existing submenu style; Radix
`ContextMenu.Sub`/`SubTrigger`/`SubContent` may need a chevron and the same
`contextMenu`/`contextMenuItem` classes already used. If a `SubTrigger` arrow or
sub-content styling is missing, add minimal CSS consistent with the existing
`.contextMenu`/`.contextMenuItem` rules — match the existing look.

## 5. Wire handlers in Sidebar.tsx

`src/components/sidebar/Sidebar/Sidebar.tsx` constructs `<ProjectItem>` and
passes the workspace handlers (see `onRenameWorkspace` around line 303). Pull
`setWorkspaceHidden` and `selectWorkspace` from the store (like
`renameWorkspace` at line 39) and pass new props:
- `onHideWorkspace={(ws, idx) => onHideWorkspace(project, ws, idx)}` (with the
  auto-switch logic from part 3)
- `onUnhideWorkspace={(ws) => setWorkspaceHidden(project.id, ws.path, false)}`

Add both props to `ProjectItemProps` in `ProjectItem.tsx`.

## Files to touch
- `src/components/sidebar/ProjectItem.tsx` — skip hidden rows; Hide menu item;
  unhide submenu; new `onHideWorkspace`/`onUnhideWorkspace` props.
- `src/components/sidebar/Sidebar/Sidebar.tsx` — read store action/selector, wire
  handlers with auto-switch logic.
- `src/components/sidebar/ProjectItem.module.css` — only if submenu styling is
  missing; match existing `.contextMenu` rules.
