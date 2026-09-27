---
title: Main-process moveProjectToHost, origin URL, path check and host-switch guard
status: done
priority: high
assignee: opus
blocked_by: []
---

# Main-process moveProjectToHost, origin URL, path check and host-switch guard

Read `docs/decisions/adr-179-clone-project-onto-host/index.md` first. This
ticket covers the "Main process" section, plus the preload, types and store
plumbing the renderer needs.

## Steps

1. **`electron/persistence.ts`**
   - Extract the clone/adopt body of `addRemoteProject` into a private
     `prepareRemoteClone(hostId, repoUrl, remoteDir): Promise<string>`, which
     returns the absolute target dir. Keep `addRemoteProject`'s behaviour
     exactly, including returning the existing project when a project already
     owns `(hostId, targetDir)`. The existing tests must keep passing.
   - Add `moveProjectToHost(projectId, { hostId, repoUrl, remoteDir })` as
     specified in the ADR: reject the local host and unknown projects; reject a
     target dir already owned by a *different* project on that host; clone or
     adopt; set `hostId` and `path`; re-detect `defaultBranch` with
     `detectDefaultBranch(this.gitForHost(hostId), targetDir)` (keep the old
     value when detection returns null); rekey the old path to `targetDir` in
     `workspaceNames`, `workspaceOrder`, `workspaceIssues`, `workspaceHidden`
     and `workspaceFolderIds`; reset `worktreePath` to `null` unless it starts
     with `~`; `saveState()`; return `buildProjectInfo`. Invalidate any cached
     per-project path state (e.g. `knownWorkspacePaths`) if needed.
   - Add `getOriginUrl(projectId): Promise<string | null>` (`git remote get-url
     origin` via `this.gitFor(project)` or the host shell exec; null on any
     error) and `projectPathExists(projectId): Promise<boolean>` (local:
     `fs.existsSync`; remote: `remoteFileExists(this.shellForHost(hostId),
     path)`).
   - Add `pathExistsOnHost(hostId, p)`, a helper the guard below uses.
2. **`electron/ipc/projects.ts`**
   - `projects:moveToHost(projectId, { hostId, repoUrl, remoteDir })`: assert
     strings, `assertKnownHostId`, reject local, `await
     backendRegistry.ensureConnected(hostId)`, then call `moveProjectToHost`.
   - `projects:getOriginUrl(projectId)` and `projects:pathExists(projectId)`.
   - Guard in `projects:update`: when `updates.hostId` is set and differs from
     the project's current host, check that the project's path exists on the
     target host (connect first for a remote host). If it does not, throw
     `Project path "<path>" does not exist on <label>. Clone it onto the host
     instead.`, where `<label>` is the host's ssh target, or "this Mac" for
     local.
3. **`electron/preload.ts`**, **`src/electron.d.ts`**: expose
   `projects.moveToHost`, `projects.getOriginUrl` and `projects.pathExists`.
4. **`src/store/project-store.ts`**: add `moveProjectToHost(projectId, opts)`.
   It calls IPC and replaces the project in the store with the returned
   `ProjectInfo`, following how `addRemoteProject` and `updateProject` update
   state.
5. **Tests** in `electron/persistence.test.ts`, following the existing
   `addRemoteProject` tests' fakes for remote shell and git: moving a project
   rekeys `workspaceNames` and similar fields; resets an absolute
   `worktreePath` but keeps a `~` one; keeps `id`, `name` and `commands`;
   adopts an existing clone; rejects a dir owned by another project; rejects
   the local host. Add a test for `projectPathExists` too, and for the IPC
   guard if an IPC test harness exists for `projects.ts`.

Run `pnpm build` (includes typecheck, zero-error baseline) and the relevant
vitest files.

## Files to touch
- `electron/persistence.ts`: `prepareRemoteClone`, `moveProjectToHost`,
  `getOriginUrl`, `projectPathExists`
- `electron/ipc/projects.ts`: new handlers and the host-switch guard
- `electron/preload.ts`, `src/electron.d.ts`: bridge methods
- `src/store/project-store.ts`: `moveProjectToHost` action
- `electron/persistence.test.ts`: tests
