---
title: Main-side planTransfer and transferProject
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Main-side planTransfer and transferProject

Implement the "Main" section of ADR-213 (`index.md`). Read it first. Read also `electron/projects/host-move.ts`, `remote-clone.ts`, `project-groups.ts`, `origin-links.ts`, `project-manager.ts` (`cloneProject`, `getOriginUrl`, `linkProjects`) and `test-fakes.ts`.

## Steps
1. New `electron/projects/host-transfer.ts`:
   - `planTransfer(ctx, projectId, hostId): Promise<TransferPlan>`. Resolve the target directory in this order: `remembered` → `adopt` → `mirror` → `default`, as the ADR describes. Return `needsInput` with reason `no-origin`, `dir-taken` or `host-taken`.
     - **Mirror:** when the source `project.path` is under `ctx.paths.homeDir(project.hostId)`, return `~/<relative path>` with forward slashes. `resolveCloneDir` later expands `~` against the target host's home.
     - **Adopt:** look for a project on `hostId` whose `originKey` matches the source's and that isn't in a different group. Reuse `OriginLinks.keyOf` or an equivalent through `ctx`. If wiring that into `ctx` is invasive, take a small `originKeyOf(projectId)` dependency.
     - **Default:** `~/code/<slug>`. Move `toDirSlug` (currently in `src/components/hosts/`) into a `src/lib/` module that both sides can import, and update its import sites.
   - `transferProject(ctx, deps, projectId, hostId, mode, overrides?)`:
     - **copy:** `cloneProject`, then `linkProjects(newId, sourceId)`, so the group is created from the source's settings.
     - **move:** `remembered` uses `switchProjectHost`. Otherwise use `moveProjectToHost`. An `adopt` plan returns `needsInput: dir-taken`.
     - With `overrides { repoUrl, targetDir }`, skip planning. Keep the `assertGroupHostFree` check and `planClone`'s owner check.
     - Return a `TransferResult` (see the ADR).
   - Export the types `TransferPlan`, `TransferResult` and `TransferInputReason`.
   - Put the types the renderer needs where `src/electron.d.ts` can import them, following how existing project types are shared.
2. `host-move.ts`: `moveProjectToHost` calls `ctx.hosts.assertKnown` instead of `assertRemote`.
3. `project-manager.ts`: add `transferProject(...)` and `planTransfer(...)` methods that delegate to the new module, the same way `moveProjectToHost` does. Remember to call `lastKnownWorkspaces.forget` on move.
4. Tests, in a new `electron/projects/host-transfer.test.ts`, using `test-fakes.ts`:
   - Plan order: `remembered` beats `adopt`, which beats `mirror`, which beats `default`.
   - Mirror maps `/Users/me/Code/x` from local to `~/Code/x`.
   - A path outside home falls back to `default`.
   - Reasons: `no-origin`, `dir-taken` (unrelated non-empty directory, and another project's owner) and `host-taken`.
   - Copy creates a new project and links it. The group gets the source's color and commands.
   - Copy of an adopted project links it without cloning.
   - Move to local with no `hostPaths` clones locally and re-points the same id.
   - Move with `remembered` uses switch, so no clone runs.
   - Overrides skip planning.
   - Update `host-move.test.ts` if any test asserted the remote-only throw.

## Files to touch
- `electron/projects/host-transfer.ts`: new.
- `electron/projects/host-transfer.test.ts`: new.
- `electron/projects/host-move.ts`: change `assertRemote` to `assertKnown`.
- `electron/projects/project-manager.ts`: delegating methods.
- `src/lib/dir-slug.ts` (or similar): the moved `toDirSlug`, plus updated imports.
- `electron/projects/types.ts`: shared result types, if that's the convention.
