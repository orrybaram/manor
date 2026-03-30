---
title: Convert listGitWorkspaces and ProjectManager to async
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Convert listGitWorkspaces and ProjectManager to async

The `listGitWorkspaces()` function uses `execSync("git worktree list --porcelain")` and is called from `buildProjectInfo()`, which is called from multiple ProjectManager methods. Convert the entire chain to async.

## Changes

1. Convert `listGitWorkspaces()` to async — use `execFileAsync("git", ["worktree", "list", "--porcelain"])` instead of `execSync`
2. Convert `buildProjectInfo()` to async (it calls `listGitWorkspaces`)
3. Convert `getProjects()` to async (it calls `buildProjectInfo`)
4. Convert `addProject()` to async (it calls `listGitWorkspaces`)
5. Convert `updateProject()` to async (it calls `buildProjectInfo`)
6. Convert `createWorktree()` to async — replace the two `execSync` calls (`git worktree prune` and `git worktree add`) with `execFileAsync`. Also calls `buildProjectInfo` at the end.
7. No changes needed to IPC handlers in `main.ts` — they already use `ipcMain.handle()` which supports async returns, and the handler functions already return the results directly (the promise will be awaited automatically).

## Files to touch
- `electron/persistence.ts` — convert `listGitWorkspaces`, `buildProjectInfo`, `getProjects`, `addProject`, `updateProject`, `createWorktree` to async
