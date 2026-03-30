---
title: Decompose ProjectItem into smaller pieces
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Decompose ProjectItem into smaller pieces

`ProjectItem.tsx` is 537 lines. Extract the two confirmation dialogs and the drag-and-drop logic.

## New files

### `src/components/RemoveProjectDialog.tsx`
- Extract the "Remove Project" `Dialog.Root` (lines ~435-465)
- Props: `open`, `onOpenChange`, `projectName`, `onConfirm`

### `src/components/DeleteWorktreeDialog.tsx`
- Extract the "Delete Workspace" `Dialog.Root` (lines ~467-533)
- Props: `open`, `onOpenChange`, `workspace` (WorkspaceInfo | null), `onConfirm` (ws, deleteBranch) => void
- Move `deleteBranchChecked` state and localStorage logic into this component

### `src/hooks/useWorkspaceDrag.ts`
- Extract the drag-and-drop logic: `handleDragStart`, `getTransformStyle`, and all drag-related state (`dragIndex`, `dropIndex`, `dragOffset`, refs)
- Hook signature: `useWorkspaceDrag({ workspaces, onReorderWorkspaces, editingPath })` → returns `{ dragIndex, handleDragStart, getTransformStyle }`

### `src/components/ProjectItem.tsx`
- Import and use the extracted components and hook
- Should shrink to ~250 lines

## Files to touch
- `src/components/ProjectItem.tsx` — extract dialogs and drag logic
- `src/components/RemoveProjectDialog.tsx` — create
- `src/components/DeleteWorktreeDialog.tsx` — create
- `src/hooks/useWorkspaceDrag.ts` — create
