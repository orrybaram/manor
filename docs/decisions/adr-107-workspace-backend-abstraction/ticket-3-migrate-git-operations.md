---
title: Implement LocalGitBackend and wire git IPC handlers
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Implement LocalGitBackend and wire git IPC handlers

Consolidate all scattered `execFile("git", ...)` calls from `main.ts` into `LocalGitBackend`, then update IPC handlers to use it.

## Implementation

### 1. Implement `electron/backend/local-git.ts`

The core is a private `exec` method that wraps `execFile("git", args, { cwd })`. All convenience methods delegate to it.

```typescript
export class LocalGitBackend implements GitBackend {
  private async execGit(cwd: string, args: string[], opts?: { timeout?: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
    // Use promisified execFile("git", args, { cwd, timeout, maxBuffer })
  }

  async exec(cwd, args, opts?) { return this.execGit(cwd, args, opts) }
  async stage(cwd, files) { await this.execGit(cwd, ["add", "--", ...files], { timeout: 10000 }) }
  async unstage(cwd, files) { await this.execGit(cwd, ["restore", "--staged", "--", ...files], { timeout: 10000 }) }
  // ... etc
}
```

**Methods to implement** (extract logic from `main.ts`):

- `stage` — from line 788-794
- `unstage` — from line 796-802
- `discard` — from line 804-815 (two-step: checkout tracked, clean untracked)
- `commit` — from line 825-835 (with allowedFlags filtering)
- `stash` — from line 817-823
- `getFullDiff` — from line 656-713 (complex: merge-base + diff + untracked files as synthetic diffs). This reads files via `fs/promises.readFile` for untracked content — the git backend should accept an optional `readFile` helper or just use `fs` directly for now since `LocalGitBackend` runs locally.
- `getLocalDiff` — from line 715-763 (similar to getFullDiff but against HEAD)
- `getStagedFiles` — from line 766-785
- `worktreeList` — extract from `persistence.ts` (search for `git worktree list --porcelain`)
- `worktreeAdd` — extract from `persistence.ts` (search for `git worktree add`)
- `worktreeRemove` — extract from `persistence.ts` (search for `git worktree remove`)

**Note on worktree methods:** `persistence.ts` has complex worktree logic (fetch, prune, branch detection). For this ticket, only extract the raw git commands. The higher-level orchestration in `ProjectManager` stays as-is but calls `backend.git.exec()` or the convenience methods instead of `execFile` directly.

### 2. Update git IPC handlers in `electron/main.ts`

Replace all `git:*` and `diffs:*` IPC handlers (lines 656-835) to delegate to `backend.git.*`:

```typescript
// Before:
ipcMain.handle("git:stage", async (_event, wsPath, files) => {
  const execFileAsync = promisify(execFile)
  await execFileAsync("git", ["add", "--", ...files], { cwd: wsPath, timeout: 10000 })
})

// After:
ipcMain.handle("git:stage", async (_event, wsPath: string, files: string[]) => {
  assertString(wsPath, "wsPath")
  await backend.git.stage(wsPath, files)
})
```

Handlers to update: `diffs:getFullDiff`, `diffs:getLocalDiff`, `diffs:getStagedFiles`, `git:stage`, `git:unstage`, `git:discard`, `git:stash`, `git:commit`.

### 3. Update `persistence.ts` git calls

`ProjectManager` in `persistence.ts` calls `execFile("git", ...)` extensively for worktree management. Update these to accept and use a `GitBackend` instance:

- Add `git: GitBackend` parameter to `ProjectManager` constructor (or a setter)
- Replace `execFileSync`/`execFile` git calls with `this.git.exec(cwd, args)`

**Be careful:** `persistence.ts` uses both `execFile` (async) and `execFileSync` (sync). The backend interface is async-only. Any sync git calls need to be converted to async, which may require making the calling function async too.

### 4. Update `diff-watcher.ts`

`DiffWatcher` runs `git merge-base` and `git diff --shortstat` on a polling interval. Update it to accept a `GitBackend` and use `git.exec()` instead of raw `execFile`.

## Files to touch
- `electron/backend/local-git.ts` — Fill in full implementation
- `electron/main.ts` — Update git/diff IPC handlers to use `backend.git`
- `electron/persistence.ts` — Update `ProjectManager` to use `GitBackend`
- `electron/diff-watcher.ts` — Update to use `GitBackend`
