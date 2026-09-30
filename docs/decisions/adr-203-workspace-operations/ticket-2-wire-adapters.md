---
title: Wire IPC handlers and control routes through workspace ops
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Wire IPC handlers and control routes through workspace ops

Per ADR-203 §2, §3, §5:

- `electron/ipc/types.ts`: `IpcDeps.workspaceOps: WorkspaceOps`.
- `electron/routes/types.ts`: `ControlDeps.workspaceOps: WorkspaceOps | null` (doc comment).
- `electron/app-lifecycle.ts`: build one instance with `createWorkspaceOps({ projectManager,
  statsStore, notifyProjectsChanged, runSetupScript })` (bridge fns from `renderer-bridge.ts`),
  put it on `ipcDeps` and in the `webviewServer.setControlDeps({...})` call. Check for other
  places that build a full `ControlDeps`/`IpcDeps` literal (tests, webview-server defaults) and
  typecheck them.
- `electron/ipc/projects.ts`: createWorktree → `workspaceOps.create(req, { runSetupScript: false })`
  returning `.project`; removeWorktree (keep the `projects:removeWorktree:progress` send) and
  quickMergeWorktree → ops. Remove `statsStore` usage.
- `electron/routes/projects.ts`: `POST /workspaces`, `POST /workspaces/batch`,
  `DELETE /workspaces`, `POST /workspaces/quick-merge` call the ops (`runSetupScript: true` for
  the single create). Delete `recordLastUsedHost` and now-unused bridge imports. 503 when
  `deps.workspaceOps` is null (a small guard helper is fine). Keep response shapes identical
  (`json(200, updated && withHostLabel(pm, updated))` etc.).
- Delete `electron/__tests__/projects-worktree-stats.test.ts`.
- `electron/routes/projects.test.ts`: give `deps()` a fake `workspaceOps` (or a real
  `createWorkspaceOps` over the fake pm with fake stats/bridge) so the host-targeting tests keep
  asserting which project id is created in; delete the last-used-host tests
  ("records the target member's host…", "leaves an unchanged host…", "records nothing for an
  unlinked project…", "still succeeds when recording…", batch "…and records it" part,
  "records nothing when no workspace was created") that the ops suite now covers. Drop the
  `vi.mock("../renderer-bridge")` if no longer needed (startAgent is still used by batch).

Run `npx tsc --noEmit -p` for the electron tsconfig (see package.json scripts) and
`npx vitest run electron/`.

## Files to touch
- `electron/ipc/types.ts`, `electron/routes/types.ts`, `electron/app-lifecycle.ts`
- `electron/ipc/projects.ts`, `electron/routes/projects.ts`
- `electron/routes/projects.test.ts`, `electron/__tests__/projects-worktree-stats.test.ts` (delete)
