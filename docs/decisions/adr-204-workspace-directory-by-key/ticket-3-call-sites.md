---
title: Move path-only lookups to WorkspaceKey
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Move path-only lookups to WorkspaceKey

See ADR-204 §4 (table). Each cross-project `projects.find(p =>
p.workspaces.some(w => w.path === X))` becomes `ownerOf(projects, key)` /
`find(projects, key)`.

## Do
- Active-key sites (`selectActiveWorkspaceKey` from app-store):
  `StatusBar.tsx` (~146), `useCommands.tsx` (~141, ~498 copy-branch),
  `keybinding-commands.ts` (`resolveWorkspaceCommand` takes a key; callers at
  ~92 and `menu-handlers.ts` ~314 pass the active key; copy-branch ~158),
  `IssueDetailView.tsx` (~76), `GitHubIssueDetailView.tsx` (~80),
  `WorkspaceSetupView.tsx` (~86).
- `src/agent-defaults.ts` `getAgentCommand`: take `WorkspaceKey | null`;
  callers `pane-actions.ts`, `ConvertToSubmenu.tsx`, `SplitWithSubmenu.tsx`,
  `useCommands.tsx` pass the active key; `agent-prompt-launch.ts` its `key`.
- `useTerminalLifecycle.ts` (~344, ~382): use the hook's `workspaceKey`
  param's host with `cwd` (`workspaceKey(parseWorkspaceKey(key).hostId, cwd)`);
  look up once, share.
- `DiffPane.tsx` (~190): `workspaceKey(hostId, workspacePath)`, guarded.
- `PortGroup.tsx` (~20): host from the group's ports' `hostId`.
- `app-commands.ts` `projectsKnowWorkspace`: use the command's `hostId`.
- `command-palette/scope.ts`: take `activeWorkspaceKey`; update its test and
  caller(s).
- Delete `command-palette/useCustomCommands.tsx` (no callers).
- Don't touch `home-dashboard*.ts`, `tasks.ts`, `TasksView.tsx`, or
  within-one-project lookups.

## Files to touch
- files listed above
