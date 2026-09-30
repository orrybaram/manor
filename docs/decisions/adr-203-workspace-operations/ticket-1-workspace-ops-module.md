---
title: Workspace operations module and its test suite
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Workspace operations module and its test suite

Create `electron/workspace-ops.ts` exactly as specified in ADR-203 §1 (`index.md` in this
folder): `WorkspaceOpsDeps`, `CreateWorkspaceRequest` (`projectId`, `name`, `branch?`,
`linkedIssue?`, `baseBranch?`, `useExistingBranch?`), `WorkspaceOps`, `createWorkspaceOps`.

- Move `recordLastUsedHost` out of `electron/routes/projects.ts` into this module (keep its doc
  comment and log-don't-throw behaviour). Do not edit the routes file in this ticket beyond
  nothing — ticket 2 deletes the old copy.
- Do NOT import `renderer-bridge.ts` or `electron`; the bridge functions are injected.
- Find the created workspace with `branchesEqual` from `src/utils/branch-name.ts` (same rule as
  `src/store/project-store.ts` `createWorktree`). Check that import is pure (no DOM/electron).
- `createFromIssues`: count created as entries with `worktreePath && !error`; `statsStore.record("worktreesCreated", n)` only when n > 0.

Tests in `electron/workspace-ops.test.ts`: plain object fakes (`vi.fn()`), no `vi.mock`. One
`describe` per operation; assert every side effect and its absence (see ADR §5).

## Files to touch
- `electron/workspace-ops.ts` — new
- `electron/workspace-ops.test.ts` — new
