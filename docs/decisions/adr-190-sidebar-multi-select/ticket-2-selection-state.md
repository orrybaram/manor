---
title: Sidebar workspace selection state and click gestures
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Sidebar workspace selection state and click gestures

See ADR-190 §1.

- New `src/store/sidebar-selection-store.ts` (zustand, same style as `drag-overlay-store.ts`) with:
  - state `{ projectId: string | null; paths: Set<string>; anchorPath: string | null }`
  - actions:
    - `setAnchor(projectId, path)` clears the selection and sets the anchor.
    - `toggle(projectId, path)` switches project if needed and moves the anchor.
    - `selectRange(projectId, orderedVisiblePaths, toPath, fallbackAnchor)`.
    - `clear()`.
    - `prune(projectId, existingPaths)`.
  - Always create a new Set on change.
- `src/components/sidebar/ProjectItem.tsx`:
  - Read the selection for this project (only when `projectId` matches).
  - Compute `visibleWorkspacePaths(items, collapsedFolderIds)` (ticket 1).
  - In `WorkspaceItem`'s `onClick`:
    - `e.shiftKey` → `selectRange(...)` with the fallback anchor = `activeWorkspacePath`, and do NOT call `onSelectWorkspace`.
    - `e.metaKey || e.ctrlKey` → `toggle`, no navigation.
    - Otherwise → `setAnchor` + navigate, as today.
  - `onPointerDown`: skip `handleDragStart` when shift/meta/ctrl is held. Also `preventDefault` on shift-pointerdown so the browser doesn't text-select.
  - Pass an `isSelected` prop and add the `.workspaceSelected` class in `ProjectItem.module.css`. Use an accent-tinted background, e.g. `color-mix(in srgb, var(--project-color, var(--accent)) 18%, transparent)`, that still reads with `.workspaceActive`.
  - Also set `aria-selected`.
  - Prune the selection when `project.workspaces` changes (effect keyed on workspaces).
  - Escape on a focused workspace row clears the selection, before the existing `handleSidebarRowKeyDown` Escape handling runs (wrap `onRowKeyDown`).
- `src/components/sidebar/Sidebar/Sidebar.tsx`: a click on the sidebar's scroll container background (`e.target === e.currentTarget`) calls `clear()`.

## Files to touch
- `src/store/sidebar-selection-store.ts` (new)
- `src/components/sidebar/ProjectItem.tsx`
- `src/components/sidebar/ProjectItem.module.css`
- `src/components/sidebar/Sidebar/Sidebar.tsx`
