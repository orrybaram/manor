---
title: Create sidebar/ directory and move sidebar components
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Create sidebar/ directory and move sidebar components

Move sidebar-related components into `src/components/sidebar/`.

## Components to move

With subdirectory (has CSS):
- `Sidebar.tsx` + `Sidebar.module.css` → `sidebar/Sidebar/Sidebar.tsx` + `Sidebar.module.css`
- `NewWorkspaceDialog.tsx` + `NewWorkspaceDialog.module.css` → `sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx` + `NewWorkspaceDialog.module.css`
- `ProjectSetupWizard.tsx` + `ProjectSetupWizard.module.css` → `sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx` + `ProjectSetupWizard.module.css`
- `TasksView.tsx` + `TasksView.module.css` → `sidebar/TasksView/TasksView.tsx` + `TasksView.module.css`
- `WelcomeEmptyState.tsx` + `WelcomeEmptyState.module.css` → `sidebar/WelcomeEmptyState/WelcomeEmptyState.tsx` + `WelcomeEmptyState.module.css`

Without subdirectory (no CSS):
- `EmptyStateShell.tsx` → `sidebar/EmptyStateShell.tsx`
- `GitHubNudge.tsx` → `sidebar/GitHubNudge.tsx`
- `ProjectItem.tsx` → `sidebar/ProjectItem.tsx`
- `PrPopover.tsx` → `sidebar/PrPopover.tsx`
- `MergeWorktreeDialog.tsx` → `sidebar/MergeWorktreeDialog.tsx`
- `DeleteWorktreeDialog.tsx` → `sidebar/DeleteWorktreeDialog.tsx`
- `RemoveProjectDialog.tsx` → `sidebar/RemoveProjectDialog.tsx`
- `TasksList.tsx` → `sidebar/TasksList.tsx`
- `WorkspaceEmptyState.tsx` → `sidebar/WorkspaceEmptyState.tsx`

## Files to touch
- `src/components/sidebar/` — create directory and move files
- All files importing these components — update import paths

## Steps
1. Create `src/components/sidebar/` and subdirectories
2. Move each component to its new location
3. Update ALL import paths across the codebase
4. Run `bun run typecheck` to verify
