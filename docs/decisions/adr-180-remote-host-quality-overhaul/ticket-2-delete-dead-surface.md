---
title: Delete dead remote-host surface
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Delete dead remote-host surface

Read `index.md`. Delete each item below, then confirm with grep that nothing
references it. Update or delete the tests that covered it.

1. **Keep-awake / provider scaffolding.**
   - Delete `electron/backend/host-busy.ts` and its tests.
   - Delete `registry.ts` `updateBusy`, the `entry.busy` field and the `trackHostBusy` wiring. Check `app-lifecycle.ts` too.
   - In `providers/types.ts`, delete `status()`, `setBusy?`, `ensureUp()`, `capabilities.autoSleep`, `capabilities.persistsMemory` and `previewUrl?`, plus their implementations and callers in `ssh-provider.ts`, `registry.ts` and `ipc/ports.ts`.
   - `ipc/ports.ts` checks for `previewUrl`; drop that branch. Drop the renderer's "copy public URL" action (`publicUrl`, `canCopyPublicUrl`) only if it is dead as a result: it always returns false today.
   - `HostProvider` keeps `kind`, `transport()`, `forwardPort()` and `dispose()`.
2. **`hostId` in `ProjectUpdatableFields`.**
   - Remove it from `electron/persistence.ts` and `src/store/project-store.ts`.
   - Delete the `projects:update` branch in `electron/ipc/projects.ts` that reroutes `hostId` through `switchHost`, plus its tests.
   - Host changes go through `projects:switchHost` / `projects:moveToHost` only.
3. **Unused host-store surface.**
   - In `src/store/host-store.ts`, delete `refresh`, `removeHost`, `clearError`, `error` and `loaded`.
   - Delete the `hosts:remove` IPC in `electron/ipc/hosts.ts`, the preload and typings entries, and `ProjectManager.removeHost`.
   - `addHost` should no longer call a full `reload()`. Main already pushes `hosts:statusChanged`.
4. **`backendType`.** Remove it from both `ProjectInfo` types and from `buildProjectInfo`.
5. **`health-check.ts`.** Make `status` required. It is marked optional "for older results", but the file is new on this branch. Derive `ok` from it wherever that simplifies things.

Run `pnpm build` and the affected vitest files.

## Files to touch
- `electron/backend/host-busy.ts` (delete) and its test
- `electron/backend/registry.ts`, `electron/backend/providers/types.ts`, `electron/backend/providers/ssh-provider.ts`
- `electron/ipc/ports.ts`, `electron/ipc/projects.ts`, `electron/ipc/hosts.ts`, `electron/app-lifecycle.ts`
- `electron/persistence.ts`, `electron/backend/health-check.ts`
- `electron/preload.ts`, `src/electron.d.ts`
- `src/store/host-store.ts`, `src/store/project-store.ts`, `src/components/ports/PortBadge.tsx` (if the public-URL action is dead)
