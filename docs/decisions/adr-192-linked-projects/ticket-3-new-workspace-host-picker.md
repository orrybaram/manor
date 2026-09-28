---
title: Host picker in the New Workspace dialog
status: done
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

## As built

- The picker's rules live in the DOM-free `src/lib/workspace-host-choices.ts` (`workspaceHostChoices`, `defaultHostChoice`, `branchNotOnHostMessage`). A remote host main reports as anything but connected is disabled. A host main hasn't reported yet is not disabled, which is the same rule as pane input.
- **Departure: which member it starts on.** The picker starts on the group's last-used host, except when the dialog is opened from one host section's own "New Workspace" (or a folder in it). In that case it starts on that section's member, because the user already chose where, and a section's folders belong to that member only. A disconnected host is never the starting choice while another member's host is available.
- **The choice is recorded by the store, not the dialog.** `createWorktree` calls `setGroupLastUsedHost` after any successful create in a linked member. This covers both dialog entry points, and it only saves when the host changes. If saving fails, the store does nothing further, because only the default is lost.
- In the dialog's project select, a group is a single option named after the group. The host picker then chooses the member.
- The picker's options reuse the host chip through a new inert `HostIndicator` `variant="label"`, which has no tooltip or click, so it can sit inside the option's `Button`.
- A missing branch is judged against the chosen host's branch lists once they have loaded. `listRemoteBranches` fetches first, so the lists reflect what origin has now. The dialog shows a hint, and Create is refused with the "push it first" message.

## Files to touch
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
- `src/store/project-store.ts`
- `electron/projects/project-groups.ts`, `project-manager.ts`, `electron/ipc/projects.ts`, `electron/preload.ts`, `src/electron.d.ts`
