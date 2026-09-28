---
title: Host picker in the New Workspace dialog
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Host picker in the New Workspace dialog

GitHub issue #246. See ADR-192 §5.

- For a grouped project, `NewWorkspaceDialog` shows a host picker with one option per member, each labeled with its host badge. It picks the member project id that the existing create call receives. Nothing else about creation changes.
- The picker defaults to the group's `lastUsedHostId`. On create, record the choice with a new ProjectManager `setGroupLastUsedHost`.
- A disconnected host is shown but disabled, with a `Tooltip` that says why.
- If the base branch doesn't exist on the chosen host, explain that it must be pushed first.
- Unlinked projects show no picker.
- Tests go through the project-store seam: member choice, remembered last-used host, and disabled offline host.

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
- `src/store/project-store.ts`
- `electron/projects/project-groups.ts`, `project-manager.ts`, `electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts`
