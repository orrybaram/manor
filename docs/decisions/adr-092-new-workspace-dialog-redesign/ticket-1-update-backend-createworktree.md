---
title: Add baseBranch parameter to createWorktree
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add baseBranch parameter to createWorktree

Add `baseBranch?: string` to the `createWorktree` method and update the IPC bridge.

## Files to touch

- `electron/persistence.ts` — Add `baseBranch?: string` parameter to `createWorktree`. When provided, use it as the ref in `git worktree add <path> -b <branchName> <baseBranch>` instead of the hardcoded `origin/${project.defaultBranch || "main"}`. Keep current behavior as fallback when `baseBranch` is not provided.

- `electron/main.ts` — Update the `projects:createWorktree` IPC handler to pass through the new `baseBranch` parameter.

- `electron/preload.ts` — Update the `createWorktree` preload bridge to accept and forward `baseBranch`.

- `src/electron.d.ts` — Update the TypeScript type for `createWorktree` to include `baseBranch?: string`.

- `src/store/project-store.ts` — Update the `createWorktree` action signature and call to pass `baseBranch` through.
