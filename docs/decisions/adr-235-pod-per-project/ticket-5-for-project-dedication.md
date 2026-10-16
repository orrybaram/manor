---
title: Hide a project's pod from other projects' host targets
status: done
priority: medium
assignee: sonnet
blocked_by: [4]
---

# Hide a project's pod from other projects' host targets

ADR-235 D5.

- Send `forProject` to the renderer in the host info (`hosts.list` /
  `HostStatusInfo`, wherever `useHostStore` gets host records).
- `transferTargets` and `AddProjectDialog`'s `remoteHostOptions` leave out a
  host whose `forProject` is set to another project's id. Compare against
  the project's group: a group member's own host counts as its own.
- Add a "Show all hosts" toggle (`Button` variant link, or a checkbox row at
  the end of the menu or select) that brings them back.
- Clearing: `ProjectManager.removeProject` / `removeHost` clear
  `forProject` when the named project is gone (ticket 6 also clears it
  explicitly when the user keeps the pod).
- Unit tests in `transfer-targets.test.ts`.

## Files to touch
- `src/lib/transfer-targets.ts` + test
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx`
- `src/components/sidebar/ProjectSetUpMenu.tsx`
- host info plumbing: `electron/bridge/handlers/hosts.ts`, `src/store/host-store.ts`
- `electron/projects/project-manager.ts` — clear dangling `forProject`
