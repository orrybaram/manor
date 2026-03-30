---
title: Auto-switch to new workspace and show wizard on creation
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Auto-switch to new workspace and show wizard on creation

When a new workspace is created, the app should immediately switch to it. The `createWorktree` store action already calls `selectWorkspace` and `setActiveWorkspace`, but the workspace may not be visible if the dialog stays open or the project isn't selected.

## Implementation

1. Verify `createWorktree` in `src/store/project-store.ts` correctly:
   - Calls `selectWorkspace(projectId, newIdx)`
   - Calls `useAppStore.getState().setActiveWorkspace(wsPath)`
   - The project is already selected (should be the active project)

2. In `App.tsx` `onSubmit` handler for `NewWorkspaceDialog` (line ~484-508):
   - After `createWorktree` succeeds, ensure the project is selected via `selectProject`
   - The dialog already closes on success (`setNewWorkspaceOpen(false)`)
   - Verify the workspace path returned maps to the correct active workspace

3. Ensure the empty state shows for the new workspace (since it has no sessions yet)

## Files to touch
- `src/App.tsx` — verify/fix workspace creation submit handler
- `src/store/project-store.ts` — verify createWorktree auto-select logic
