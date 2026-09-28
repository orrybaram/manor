---
title: Clone a project onto any host, including this machine
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Clone a project onto any host, including this machine

See ADR-194 §1.

- `electron/projects/project-manager.ts`: rename `addRemoteProject` →
  `cloneProject(opts: { hostId; repoUrl; targetDir; name })`; use
  `this.hosts.assertKnown(opts.hostId)`. Keep the owner/adopt behaviour.
- `electron/projects/host-move.ts`: `planRemoteClone` → `planClone`,
  `runRemoteClone` → `runClone`; `planClone` resolves the dir with
  `resolveCloneDir`. `moveProjectToHost` keeps `assertRemote` and continues
  to use the strict remote rule (it only targets remote hosts anyway).
- `electron/projects/remote-clone.ts`: add `resolveCloneDir(isLocal, dir,
  homeDir, join)`. Remote → existing `resolveRemoteDir`. Local → trimmed; must
  be `~`, start with `~/` or `/`; must not start with `-`; expand `~`; must not
  resolve to `/`. Add unit tests next to existing remote-clone tests.
- `electron/ipc/projects.ts`: `projects:addRemote` → `projects:clone` with
  `{ hostId, repoUrl, targetDir, name }`; `assertKnownHost`; call
  `backendRegistry.ensureConnected` only when `hostId !== LOCAL_HOST_ID`.
- `electron/preload.ts` + the renderer's `electronAPI` type: `projects.clone`.
- `src/store/project-store.ts`: `addRemoteProject` → `cloneProject` (same
  opts shape, `targetDir`). Update `AddProjectDialog.tsx` call site minimally
  (rename only, `remoteDir` → `targetDir`) so the build stays green.
- Update tests/fixtures referencing `addRemote`/`addRemoteProject`
  (`grep -rn "addRemote" electron src tests`).

## Files to touch
- `electron/projects/project-manager.ts`
- `electron/projects/host-move.ts`
- `electron/projects/remote-clone.ts` (+ its test)
- `electron/ipc/projects.ts`
- `electron/preload.ts`
- `src/store/project-store.ts`
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx` (rename only)
- tests referencing the old names
