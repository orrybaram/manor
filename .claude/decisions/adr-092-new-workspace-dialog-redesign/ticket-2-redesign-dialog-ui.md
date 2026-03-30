---
title: Redesign NewWorkspaceDialog UI
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Redesign NewWorkspaceDialog UI

Rework the dialog to have: Name input, Base branch combobox, and auto-derived branch name hint.

## Files to touch

- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx` — Major rework:
  1. Remove the `branch` state and manual branch input field
  2. Add `baseBranch` state, defaulting to `main` (or project's `defaultBranch`)
  3. Repurpose the existing combobox/dropdown for base branch selection instead of branch name
  4. Compose branch list: local default branch first, then `origin/{defaultBranch}`, then remote branches (already fetched via `listRemoteBranches`)
  5. Show a read-only hint below the name field: "Branch: `{slugify(name)}`" so user sees what branch will be created
  6. Update `onSubmit` call to pass `baseBranch` instead of `branch`
  7. Update the `onSubmit` prop type to `(projectId: string, name: string, branchName: string, baseBranch: string) => Promise<boolean>`
  8. Remove `initialBranch` prop (no longer needed since branch name is auto-derived)

- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.module.css` — Add a style for the branch name hint text (small, muted, monospace).

- `src/App.tsx` — Update the `onSubmit` handler for `NewWorkspaceDialog` to pass `baseBranch` to `createWorktree`. Remove `initialBranch` prop.
