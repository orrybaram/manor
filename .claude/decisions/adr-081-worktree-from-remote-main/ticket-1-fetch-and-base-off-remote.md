---
title: Fetch and base new worktrees off origin/defaultBranch
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Fetch and base new worktrees off origin/defaultBranch

In `electron/persistence.ts`, modify the `createWorktree()` method:

1. When no explicit `branch` is provided (i.e., creating a new branch), fetch `origin` before creating the worktree
2. Change the first `git worktree add` attempt from:
   `git worktree add <path> -b <branchName>` (bases off HEAD)
   to:
   `git worktree add <path> -b <branchName> origin/<defaultBranch>` (bases off remote main)

The project's `defaultBranch` field is available on the project object.

## Files to touch
- `electron/persistence.ts` — modify `createWorktree()` method (~lines 720-745)
