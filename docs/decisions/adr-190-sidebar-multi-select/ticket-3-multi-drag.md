---
title: Drag a multi-selection into and out of folders
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Drag a multi-selection into and out of folders

See ADR-190 §3.

- `src/hooks/useSidebarDrag.ts`:
  - `handleDragStart(key, kind, e, groupKeys?: string[])` stores the group for the gesture.
  - `onDrop(sourceKey, target, rows, groupKeys)` forwards it.
  - Expose `dragGroupKeys` (state, set when the drag becomes active, cleared on up) so rows can render dimmed.
  - Pointer and geometry math stay keyed on the grabbed row only.
- `src/components/sidebar/ProjectItem.tsx`:
  - On a workspace pointerdown, if the row is selected and the selection (for this project) has 2+ paths, pass the selection in tree order (filter `visibleWorkspacePaths` by the selection, then append any selected path that is not visible) as `groupKeys`.
  - `handleDrop` calls `applyGroupDrop(items, sourceKey, groupKeys ?? [sourceKey], target, rows)`.
  - Rows in `dragGroupKeys` other than the grabbed one get `isDragging`-style dimming.
  - The grabbed row shows a small count badge when the group is 2+. Add `.dragCountBadge` to `ProjectItem.module.css`: pill, accent background, positioned at the row's right edge.
  - Clear the selection after a successful group drop.
- Folder drags are unchanged (never grouped).

Test manually by reasoning through `applyGroupDrop`. Keep typecheck and the existing `sidebar-items` tests green.

## Files to touch
- `src/hooks/useSidebarDrag.ts`
- `src/components/sidebar/ProjectItem.tsx`
- `src/components/sidebar/ProjectItem.module.css`
