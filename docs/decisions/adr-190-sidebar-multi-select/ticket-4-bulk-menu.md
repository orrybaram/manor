---
title: Bulk context menu with delete, hide, and move to folder
status: todo
priority: high
assignee: sonnet
blocked_by: [1, 2, 3]
---

# Bulk context menu with delete, hide, and move to folder

See ADR-190 §2.

- `src/store/workspace-actions.ts`:
  - `removeWorktreeWithToast` returns `Promise<void>` (the existing chain). Callers that ignore it keep working.
  - Add `removeWorktreesWithToast(project, workspaces, deleteBranch)`:
    - Skip `isMain`.
    - If the active workspace is in the set, first `selectWorkspace` the first remaining workspace (prefer main).
    - Then `await` each removal in sequence.
  - Add `hideWorkspacesAndNavigate(projectId, paths)`: skip main, navigate away first if the active one is in the set, then await `setWorkspaceHidden` sequentially.
- `src/store/project-store.ts`: let `createWorkspaceFolder` accept `anchorKey?: string | string[]`. With an array, insert the folder before the first key, then `placeManyInFolder` all keys. Keep the single-key behaviour identical.
- New `src/components/sidebar/BulkDeleteWorktreesDialog.tsx`, modeled on `DeleteWorktreeDialog.tsx`, using the same `dialogs.module.css` classes and the same localStorage key:
  - title "Delete N Workspaces"
  - a scrollable list of names and branches
  - "Also delete local branches" checkbox
  - Cancel and Delete (`Button` from `ui/Button`)
- New `src/components/sidebar/WorkspaceBulkMenu.tsx`. It renders the `ContextMenu.Content` for a multi-selection with these items:
  - disabled header "N workspaces selected"
  - Move to Folder ▸ (folder choices + New Folder…)
  - Remove from Folder (only if any selected workspace has a `folderId`)
  - separator
  - Hide N Workspaces (count excludes main; hidden when 0)
  - Delete N Workspaces… (danger; count excludes main; hidden when 0)

  Props are callbacks plus `folderChoices`. Reuse `ProjectItem.module.css` context-menu classes.
- `src/components/sidebar/ProjectItem.tsx`:
  - In the workspace `ContextMenu.Root`'s `onOpenChange(open)`: if the row is not in the current selection, clear the selection.
  - Render `WorkspaceBulkMenu` instead of the single menu when the row is selected and the selection has 2+ paths.
  - Wire the actions:
    - `applySidebarChange(projectId, placeManyInFolder(...))`
    - `placeManyAfterFolders`
    - New Folder… with pending anchor keys (generalize `pendingMovePath` to `string[] | null`)
    - `hideWorkspacesAndNavigate`
    - open `BulkDeleteWorktreesDialog` → mark all paths in `deletingPaths` → `removeWorktreesWithToast`.
  - Clear the selection after each action.

## Files to touch
- `src/store/workspace-actions.ts`
- `src/store/project-store.ts`
- `src/components/sidebar/BulkDeleteWorktreesDialog.tsx` (new)
- `src/components/sidebar/WorkspaceBulkMenu.tsx` (new)
- `src/components/sidebar/ProjectItem.tsx`
