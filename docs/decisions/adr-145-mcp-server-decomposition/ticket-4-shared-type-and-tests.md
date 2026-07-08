---
title: Share AppCommand type; retarget batch tests
status: todo
priority: medium
assignee: sonnet
blocked_by: [1, 2, 3]
---

# Share AppCommand type; retarget batch tests

## Shared `AppCommand` type (Finding 6 nit)
The `{ cmd; workspacePath?; prompt? }` payload is duplicated in `preload.ts`,
`src/electron.d.ts`, and `src/App.tsx`. Define it once and reuse. Put
`export interface AppCommand { cmd: string; workspacePath?: string; prompt?: string }`
in a shared spot both sides can import (e.g. `electron/control-server.ts` re-uses
it for `startAgent`, and the renderer types reference the same shape). Keep it
DRY without creating a cross-boundary import cycle — if a shared import isn't
clean, a single `AppCommand` in `src/electron.d.ts` referenced by `App.tsx`, with
`control-server.ts` holding its own copy, is acceptable; the goal is no 3× inline
duplication in the renderer.

## Tests
`electron/__tests__/mcp-webview-server.test.ts` — the batch describe block:
- The mock `ProjectManager` now needs `createWorkspacesFromIssues` (the route no
  longer calls `createWorktree` for batch). Replace the `createWorktree` spy +
  assertions in the batch tests with `createWorkspacesFromIssues` returning
  `[{ number, title, body, url, worktreePath }]` per issue.
- Keep asserting: two issues → one result each; `assign:true` → `assignIssue`
  called; a failing issue still returns the others; `start_agent` payload correct.
- `GET /issues`, `POST /agents`, and the project/workspace CRUD tests are
  unchanged and must stay green.

## Verify
`pnpm test electron/__tests__/mcp-webview-server.test.ts electron/persistence.test.ts`
green; `pnpm build` clean.

## Files to touch
- `electron/preload.ts`, `src/electron.d.ts`, `src/App.tsx` — dedupe `AppCommand`
- `electron/__tests__/mcp-webview-server.test.ts` — retarget batch tests
