---
title: Workspace directory module, fold host-id into workspace-key
status: done
priority: high
assignee: opus
blocked_by: []
---

# Workspace directory module, fold host-id into workspace-key

See ADR-204 §1 and §5.

## Do
- Create `src/lib/workspace-directory.ts` with `keyOf`, `find`, `ownerOf`,
  `patch`, `reconcile`, `hostForPath` as specified in ADR-204 §1. Pure; generic
  over a minimal project shape; `patch` returns the same array when `fn`
  returns the workspace unchanged, and only touches the key's host.
  `reconcile` carries `pr`/`diffStats` only when key and branch
  (`branchesEqual` from `src/utils/branch-name`) both match. Doc comments in the
  style of `workspace-key.ts`.
- Move `HostId`, `LOCAL_HOST_ID`, `normalizeHostId` from `src/lib/host-id.ts`
  into `src/lib/workspace-key.ts`, delete `host-id.ts`, update every importer
  (src and electron; `grep -rn 'host-id"'`), including the pin test in
  `electron/projects/workspace-key.test.ts`.
- `src/lib/hosts.ts`: delete `hasWorkspace`, `projectForWorkspace`,
  `hostIdForWorkspace`, `workspaceHostId`, `selectedProjectId` if unused
  elsewhere. Keep `projectForWorkspaceKey` only as
  `export { ownerOf as projectForWorkspaceKey } from "./workspace-directory"`
  with a comment that it stays until `home-dashboard.ts` moves over (ADR-204 §4).
  Re-point all other `projectForWorkspaceKey` importers to `ownerOf`
  (App.tsx, app-store.ts, useMenuContextSync, useNavigationHistory,
  agent-context-repair, agent-navigation, app-commands,
  active-workspace-host.ts, menu-handlers, agent-prompt-launch) — NOT
  `home-dashboard.ts`.
- `workspaceHostId` callers (`app-store.ts` `layoutKeyFor`, `project-store.ts`
  `startSetupScript`) switch to `hostForPath`.
- Tests: `src/lib/__tests__/workspace-directory.test.ts`, plain data, incl.
  "same path on two hosts, patching one leaves the other alone", "patch no-op
  returns the same array", "reconcile keeps the PR only when both key and
  branch match", "ownerOf matches the main checkout path", `hostForPath`
  (Home local, selected project wins, unknown path undefined). Delete the
  now-redundant describes from `src/lib/__tests__/hosts.test.ts`.

## Files to touch
- `src/lib/workspace-directory.ts` (new), `src/lib/__tests__/workspace-directory.test.ts` (new)
- `src/lib/workspace-key.ts`, `src/lib/host-id.ts` (delete), `src/lib/hosts.ts`, `src/lib/__tests__/hosts.test.ts`
- importers of `host-id`, `projectForWorkspaceKey`, `workspaceHostId` listed above
