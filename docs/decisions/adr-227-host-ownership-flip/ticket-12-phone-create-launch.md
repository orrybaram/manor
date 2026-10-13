---
title: Phone creates workspaces and launches agents on a host server
status: todo
priority: high
assignee: sonnet
blocked_by: [5, 10, 11]
---

# Phone creates workspaces and launches agents on a host server

ADR-227 D6 (renderer side).

## Do
- **Remove the slice-1 refusals:**
  - `hostServer: false` on `new-agent` and `new-workspace`
    (`src/lib/commands.ts:434-449`)
  - the `isHostServer()` branch and the `host-server-new-agent` toast in
    `src/lib/keybinding-commands.ts:140-153`
  - the unavailable state in
    `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx:172-174,
    249, 261, 411, 561-572`
- **Keep the `hostServer` command field and `commandAvailableOnHostServer`.**
  They stay for commands that still need the desktop. Check every
  `hostServer: false` command, and keep it only where the host table still
  refuses.
- **Refused layout writes.** `sendLayoutCommand` and `sendPendingCommand`
  (`src/store/app-store.ts:1215-1271`) route refusals through
  `handleBridgeUnavailable` (`src/lib/bridge-unavailable-toast.ts:35`)
  instead of only logging. This covers `unavailable:host-away` and
  `unavailable:host`.
- **Composer.** The ADR-222 composer (`src/components/phone/NewAgent/*`) must
  work against a host server: existing workspace, new worktree, and
  start-from-issue (`src/lib/start-issue-work.ts`) with GitHub and Linear.
  Fix any desktop-only assumption you find there.
- **New-worktree flow.** `src/store/project-store.ts`'s `createWorktree`
  no longer runs the setup script itself (ticket 4). Check that the
  new-worktree path still opens the agent tab.
- **Update the tests:**
  - `src/lib/__tests__/command-availability.test.ts`
  - `src/lib/__tests__/keybinding-commands.test.ts`
  - `src/bridge/__tests__/connection.test.ts`: if the copy helper becomes
    unused, delete `hostServerUnavailableCopy`.

## Files to touch
- `src/lib/commands.ts`
- `src/lib/keybinding-commands.ts`
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
- `src/store/app-store.ts`
- `src/bridge/connection.ts`
- `src/components/phone/NewAgent/*`
- `src/lib/start-issue-work.ts`
- `src/lib/__tests__/command-availability.test.ts`
- `src/lib/__tests__/keybinding-commands.test.ts`
