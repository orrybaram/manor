---
title: Route branch reads and prewarm through the backend
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Route branch reads and prewarm through the backend

**Prerequisite:** ADR-160 ticket 9 (registry).

Three places read the local disk or local daemon directly (ADR-178 §3).

1. `BranchWatcher` (`electron/branch-watcher.ts:60-86`) stats `.git` and reads `HEAD`
   with `fs`. Replace with the project's backend: prefer an existing `git` method that
   returns the current branch (check `electron/backend/local-git.ts`; add
   `currentBranch(repoPath)` using `git rev-parse --abbrev-ref HEAD` if none). Keep the
   2s poll for local; for remote hosts poll at 5s and skip a tick while a previous one
   is in flight so a slow host can't pile up requests.
2. `readBranchSync` (`electron/ipc/pty.ts:9`) → async `readBranch(backend, repoPath)`
   with the same semantics; update callers.
3. `removeWorktree` in `electron/persistence.ts`: after a failed `git worktree remove`, it checks
   `existsSync(worktreePath)` on the LOCAL disk to decide whether the directory is gone.
   For remote projects route that check through the host (e.g. `test -e` via the shell
   backend, as `remoteFileExists` in persistence.ts does).
4. `PrewarmManager` (`electron/prewarm-manager.ts`) uses `this.client` directly. Make it
   take the registry and prewarm **only for projects whose hostId is local**. Remote
   projects get no prewarm in this ADR.

Local behavior unchanged; existing branch-watcher and pty tests pass.

## Files to touch
- `electron/branch-watcher.ts` — backend-based HEAD reads, per-host interval.
- `electron/ipc/pty.ts` — async `readBranch`.
- `electron/backend/local-git.ts`, `electron/backend/types.ts` — `currentBranch` if missing.
- `electron/prewarm-manager.ts` — registry, local-only prewarm.
- `electron/app-lifecycle.ts` — constructor wiring.
