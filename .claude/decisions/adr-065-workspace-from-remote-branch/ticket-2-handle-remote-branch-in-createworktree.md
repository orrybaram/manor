---
title: Handle remote branches in createWorktree
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Handle remote branches in createWorktree

Update the `createWorktree` method in `electron/persistence.ts` to handle remote-only branches by adding a third fallback step.

## Implementation

Currently the method tries:
1. `git worktree add <path> -b <branch>` (create new branch)
2. `git worktree add <path> <branch>` (checkout existing local branch)

Add a third attempt when both fail:
3. `git worktree add <path> -b <branch> origin/<branch>` — creates a local branch tracking the remote

This creates a local branch named `<branch>` that tracks `origin/<branch>` and checks it out in the new worktree. Before attempting this, run `git fetch origin <branch>` to ensure we have the latest ref.

The fallback chain becomes:
```
try -b (new branch)
catch → try existing local
catch → try fetch + track remote
catch → throw
```

## Files to touch
- `electron/persistence.ts` — modify `createWorktree` to add remote branch fallback
