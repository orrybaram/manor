---
title: Split persistence.ts into electron/projects/ and use MachineFacts
status: todo
priority: high
assignee: opus
blocked_by: [6]
---

# Split persistence.ts into electron/projects/ and use MachineFacts

Read `index.md`. `electron/persistence.ts` is about 2250 lines. `ProjectManager`
has picked up host records, path routing, remote cloning and host moves.

1. **Split into `electron/projects/`.** Keep `electron/persistence.ts` as a thin
   re-export, or update the imports.
   - `state-store.ts`: load, save and the debounced save.
   - `host-records.ts`: `saveHost`, `getHosts`, the hook cursors,
     `flushHostHookSeqs`.
   - `path-router.ts`: `hostIdForPath`, the worktree base dir, the home-dir
     cache. Make its dependency on `knownWorkspacePaths` explicit rather than a
     side effect of `buildProjectInfo`.
   - `remote-clone.ts`: pure functions over `(git, facts, emit)`:
     `prepareRemoteClone`, `remoteDirState`, `remoteDirIsCloneOf`,
     `cloneWithProgress`.
   - `host-move.ts`: `moveProjectToHost`, `switchProjectHost`,
     `repointProject`, `rekeyRecord`.
   - `worktrees.ts` and `workspace-folders.ts`: the worktree create, remove,
     quick-merge and convert operations, and the folder operations.
   - `ProjectManager` stays as the facade that owns state and composes these.
2. **Remove local/remote branches with `backend.facts`** (ticket 6):
   - The `package.json` seeding in `addProject` becomes one helper. Delete
     `readRemotePackageJson` and `remoteFileExists`.
   - `pathExistsOnHost` and the inline check in `removeWorktree` use
     `facts.exists`.
   - `worktreePathFor`, `worktreeBaseDir` and `homeDirFor` use `facts` and
     `defaultWorktreeRoot`.
   - Delete the duplicated four-way rule: `worktreeBaseDir` awaits the home dir
     and then calls `syncWorktreeBaseDir`.
3. **Fix the `~` bug.** Store a `~` worktree root unexpanded and expand it only
   when read. That removes the host round trip from `updateProject` and makes
   the `~` branch in `repointProject` real. Add a test: set `~/trees`, move the
   project to a host, and the root is still `~/trees`.
4. **Cleanups:**
   - One `assertRemoteHost(hostId)` in the manager; delete the IPC duplicates.
   - `switchProjectHost` resolves the host label itself; drop the `hostLabel`
     parameter and the IPC lookup.
   - `prepareRemoteClone` takes an already-resolved target dir.
   - Run the owner check for both `addRemoteProject` and `moveProjectToHost`.
   - Move `hosts:healthCheck` into `electron/ipc/hosts.ts`.
   - Normalize `hostId` in `loadState`, stripping local on save if byte-identical
     records matter. Make it required on `PersistedProject` and `ProjectInfo`,
     and delete the 15 `?? LOCAL_HOST_ID` re-defaults.

No file under `electron/projects/` may exceed 600 lines. Run `pnpm build`,
`electron/persistence.test.ts` (split it if that helps) and the
`electron/ipc` tests.

## Files to touch
- `electron/persistence.ts`
- `electron/projects/*` (new)
- `electron/ipc/projects.ts`, `electron/ipc/hosts.ts`
- `src/store/project-store.ts` (the `ProjectInfo.hostId` type), `src/electron.d.ts`
- related tests
