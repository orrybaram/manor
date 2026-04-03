---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-006: Fix Main Thread Blocking from Sync Operations

## Context

The Electron main process has several places where synchronous, blocking operations run on the main thread without user action. These cause UI freezes ("hangups"):

1. **GitHubManager** (`electron/github.ts`) — `execSync("gh pr list ...")` with 10s timeout, called per branch. The `usePrWatcher` hook calls `getPrsForBranches` on mount and every 60s via `setInterval`. With multiple branches, this can block the main thread for `N × 10s`.

2. **`listGitWorkspaces()`** (`electron/persistence.ts:420-474`) — `execSync("git worktree list --porcelain")` with 5s timeout. Called from `buildProjectInfo()`, which is called from `getProjects()`. The renderer calls `projects:getAll` on mount, blocking the main thread.

3. **BranchWatcher** (`electron/branch-watcher.ts`) — `fs.statSync()` + `fs.readFileSync()` per workspace path, every 2 seconds via `setInterval`. With many workspaces this accumulates.

All three fire automatically without user action — on startup or on polling timers.

## Decision

Convert all three to fully async implementations:

1. **GitHubManager**: Replace `execSync` with `execFileAsync("gh", [...])`. Convert `getPrsForBranches` to use `Promise.allSettled` for parallel fetching instead of sequential blocking loop.

2. **`listGitWorkspaces()`**: Replace `execSync` with `execFileAsync("git", ["worktree", "list", "--porcelain"])`. Since `buildProjectInfo()` calls it, `buildProjectInfo()` and all callers (`getProjects`, `addProject`, `updateProject`, `createWorktree`) become async. The IPC handlers already use `ipcMain.handle()` which supports async return values, so this is seamless.

3. **BranchWatcher**: Replace `fs.statSync`/`fs.readFileSync` with `fs.promises.stat`/`fs.promises.readFile`. Add a `scanning` guard flag (like PortScanner and DiffWatcher already have) to prevent overlapping ticks.

## Consequences

- **Positive**: UI will no longer freeze from background polling or startup project loading.
- **Positive**: GitHub PR fetching becomes parallel per-branch instead of sequential, making it faster.
- **Risk**: `createWorktree()` in persistence.ts also uses `execSync` — it's user-triggered so less critical, but we'll convert it too while we're here since `listGitWorkspaces` (which it calls via `buildProjectInfo`) is becoming async anyway.
- **Tradeoff**: Slightly more complex control flow with async/await, but the patterns already exist in DiffWatcher and PortScanner.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
