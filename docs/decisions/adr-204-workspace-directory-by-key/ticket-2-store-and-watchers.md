---
title: Store actions and watchers address workspaces by key
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Store actions and watchers address workspaces by key

See ADR-204 §2 and §3.

## Do
- `src/store/project-store.ts`: `updateWorkspaceBranch/DiffStats/Pr` take a
  `WorkspaceKey` and are implemented with `patch` from
  `src/lib/workspace-directory.ts`, keeping their equality checks
  (`branchesEqual`, diff-stat added/removed equality with missing == null,
  `prEqual`) inside the patch fn; return `s` when `patch` returns the same
  array. Replace `keepWatchedState` with `reconcile` at its call sites
  without otherwise restructuring `createWorktree`/`removeWorktree`.
- `electron/branch-watcher.ts`, `electron/diff-watcher.ts`: key scan results
  by `workspaceKey(hostId, path)` (import from `../src/lib/workspace-key`);
  `DiffWatcher.defaultBranches` and `nonGitPaths` keyed by key too. Update
  `electron/preload.ts` / `src/electron.d.ts` channel types to
  `Record<WorkspaceKey, …>` (or string with a doc comment if branding across
  the boundary is awkward).
- `src/hooks/useBranchWatcher.ts`, `useDiffWatcher.ts`: pass keys through;
  `useDiffWatcher`'s map keyed by `keyOf(p, ws)`, entries still send
  `{ path, hostId, defaultBranch }` to main.
- `src/hooks/usePrWatcher.ts`: `updateWorkspacePr(keyOf(project, ws), pr)`.
- Tests: delete `src/store/__tests__/project-store-refresh-keeps-pr.test.ts`,
  `project-store-diff-stats.test.ts`, `project-store-pr-equality.test.ts`
  after checking each case is covered by `workspace-directory.test.ts` (move
  the prEqual queued/conflicting cases there or into a small `prEqual` test
  if `prEqual` is exported). Add a two-host same-path case to
  `electron/branch-watcher.test.ts` (and the diff watcher test if one exists).

## Files to touch
- `src/store/project-store.ts` (updateWorkspace*, keepWatchedState only)
- `electron/branch-watcher.ts`, `electron/diff-watcher.ts`, `electron/preload.ts`, `src/electron.d.ts`
- `src/hooks/useBranchWatcher.ts`, `src/hooks/useDiffWatcher.ts`, `src/hooks/usePrWatcher.ts`
- the three store tests (delete), `electron/branch-watcher.test.ts`
