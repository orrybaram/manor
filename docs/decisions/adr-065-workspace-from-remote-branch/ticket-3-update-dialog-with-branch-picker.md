---
title: Add remote branch picker to NewWorkspaceDialog
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Add remote branch picker to NewWorkspaceDialog

Update the `NewWorkspaceDialog` to include a combobox/dropdown for selecting remote branches, replacing the plain text input for the branch field.

## Implementation

Update `NewWorkspaceDialog.tsx`:

1. **Fetch remote branches on dialog open** — when the dialog opens, call `window.electronAPI.projects.listRemoteBranches(projectId)` to get available remote branches. Store in local state. Show a loading indicator while fetching. Re-fetch when the selected project changes.

2. **Replace branch text input with a combobox** — the branch field should be a text input with a dropdown suggestion list filtered by the user's input. The user can:
   - Type a custom branch name (creates a new branch, existing behavior)
   - Select from the dropdown (uses a remote branch)
   - The dropdown filters as the user types

3. **Auto-fill name from branch selection** — when the user picks a remote branch from the dropdown and the name field is empty, auto-populate the name with the branch name.

4. **CSS additions** — add styles for the dropdown list, loading state, and selected/highlighted items to `NewWorkspaceDialog.module.css`. Follow existing patterns (use CSS variables like `--bg`, `--surface`, `--text-selected`, `--accent`).

## UX Details
- Show "Loading branches..." while fetching
- Show "No matching branches" when filter has no results
- Highlight the currently focused item in the dropdown
- Support keyboard navigation (arrow up/down, enter to select, escape to close)
- Dropdown appears on focus or typing; disappears on blur or selection

## Files to touch
- `src/components/NewWorkspaceDialog.tsx` — add branch fetching + combobox UI
- `src/components/NewWorkspaceDialog.module.css` — add dropdown styles
