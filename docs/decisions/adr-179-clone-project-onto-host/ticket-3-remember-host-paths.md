---
title: Remember each host's path so switching back restores it
status: done
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Remember each host's path so switching back restores it

Follow-up found in use: after "Clone onto host", switching the project back to
Local failed with `Project path "/home/orryb/code/gary" does not exist on this
Mac`, because the move overwrote `path` and the original local checkout was
forgotten.

- `PersistedProject.hostPaths: Record<hostId, string>` records the path a
  project is leaving on every repoint.
- `ProjectManager.switchProjectHost(projectId, hostId, path?, label)` switches
  without cloning, to an explicit path, else the remembered one, else the
  current one. It refuses a path that doesn't exist on the target (or one
  another project owns), rekeys the main workspace's per-path settings, and
  drops `hostId` for local. `moveProjectToHost` shares the repoint logic.
- IPC: `projects:switchHost`; `projects:update` routes a `hostId` change
  through it, replacing the bare-assignment guard.
- Settings: switching hosts calls `switchProjectHost`. When a switch to Local
  fails (no path remembered, as for projects moved before this ticket), a
  **Choose local folder…** button opens the folder picker and switches to the
  chosen checkout. Electron's "Error invoking remote method" prefix is
  stripped from the displayed error.

## Files to touch
- `electron/persistence.ts`, `electron/persistence.test.ts`
- `electron/ipc/projects.ts`, `electron/ipc/__tests__/projects-host-validation.test.ts`
- `electron/preload.ts`, `src/electron.d.ts`, `src/store/project-store.ts`
- `src/components/settings/ProjectSettingsPage.tsx`
