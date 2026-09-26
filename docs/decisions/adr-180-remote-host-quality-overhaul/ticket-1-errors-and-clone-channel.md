---
title: Shared error helpers, typed clone-progress channel
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Shared error helpers, typed clone-progress channel

Read `index.md` in this folder first.

1. **Renderer error helper.**
   - Add `src/lib/ipc-error.ts` exporting `ipcErrorMessage(err: unknown): string`.
   - It strips Electron's `Error invoking remote method '…': <Name>Error: ` prefix.
   - Replace every renderer copy with it, including:
     - `errorMessage` in `ProjectSettingsPage.tsx`, `AddProjectDialog.tsx` and `CloneToHostDialog.tsx`
     - the inline regex in `project-store.ts` `convertMainToWorktree`
     - the raw messages stored by `src/store/host-store.ts`
     - `toast-store` detail messages, where one strips the prefix by hand
2. **Main error helper.**
   - Add `electron/lib/errors.ts` exporting `errorMessage(err: unknown): string`.
   - Replace the copies in `electron/backend/registry.ts`, `hook-feed.ts` and `health-check.ts`.
   - Replace the inlined `err instanceof Error ? err.message : String(err)` in `remote-backend.ts`, `remote-exec.ts` and `local-git.ts`.
   - Also replace it in any other file this branch added. Check with `git diff bebdb0b0 HEAD --stat`.
3. **Clone progress on its own channel.**
   - Today `ProjectManager` emits clone progress through `emitSetupProgress("clone", …)` on `worktree:setup-progress`. `createWorktree`'s listener in `project-store.ts` writes every event on that channel into the `"__pending__"` worktree setup state.
   - Give clone progress its own channel, `projects:clone-progress`, with a typed payload `{ status: "in-progress" | "done" | "error"; message?: string }`.
   - Expose it as `projects.onCloneProgress` in `preload.ts` and `electron.d.ts`.
   - Switch `AddProjectDialog` and `CloneToHostDialog` to it and delete their `event as { step?: …}` casts.
   - Remove `"clone"` handling from the worktree channel.
4. **Typed host status event.** Type `hosts.onStatusChanged` in preload as `(hosts: HostStatusInfo[]) => void`, not `unknown`.

## Files to touch
- `src/lib/ipc-error.ts` (new): the renderer error helper
- `electron/lib/errors.ts` (new): the main-process error helper
- `electron/persistence.ts`: emit clone progress on the new channel
- `electron/preload.ts`, `src/electron.d.ts`: expose `onCloneProgress`; type `onStatusChanged`
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx`, `src/components/settings/CloneToHostDialog/CloneToHostDialog.tsx`, `src/components/settings/ProjectSettingsPage.tsx`: use the helper and the new channel
- `src/store/project-store.ts`, `src/store/host-store.ts`, `src/store/toast-store.ts` (if it strips by hand): use the helper
- the backend files listed above: use the main helper
