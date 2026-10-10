---
title: Set-up dialog, New Workspace picker and Project Settings
status: todo
priority: high
assignee: sonnet
blocked_by: [3]
---

# Set-up dialog, New Workspace picker and Project Settings

Implement ADR-214's "Set-up dialog", "New Workspace" and "Project Settings" surfaces.

## Steps
1. `src/components/hosts/CloneToHostDialog.tsx`:
   - Merge the `copy` and `addToGroup` modes into one `setUp` mode, titled "Set up <name> on <host>", that submits through `setUpOnHost`.
   - Keep `move` for the repair path.
   - When the selected host is This machine, add a "Use an existing folder…" `Button`. It runs `pickDirectory()` and sets the directory field. Submitting adopts the checkout, because `planClone` adopts a clone of the same origin.
   - Update `TransferDialogHost.tsx` for the new modes.
2. `src/components/sidebar/NewWorkspaceDialog/HostPicker.tsx` and `NewWorkspaceDialog.tsx`:
   - Rename "Clone onto another host…" to "Set up on another host…".
   - Build its targets with `transferTargets(project, …, "copy")`, so lone projects get it too.
   - Open the dialog in `setUp` mode. After it succeeds, select the new host in the picker, as the `addToGroup` flow does today.
   - Delete `hostsToCloneOnto` and the store's `cloneIntoGroup` if nothing else uses them, together with their tests (`project-store-clone-into-group.test.ts`, and the related cases in `workspace-host-choices` tests).
3. `src/components/settings/ProjectHostSection/ProjectHostSection.tsx`:
   - Replace the "Change host…" select (move) with a "Set up on…" select (copy, through `setUpOnHost`). Keep "Add new host…" in it, so a new host gets added and the project set up there.
   - When the repo is missing on its host, show the repair actions: "Clone it again" (`transferProject(id, currentHostId, "move")`) and "Point at another folder…" (`switchProjectHost(id, currentHostId, picked)` with `pickDirectory`).
   - Remove the host-switch path. Drop the open-panes confirm if it is no longer needed.
4. `src/components/settings/ProjectLinksSection.tsx`:
   - Turn it into a **Hosts** section (rename the file and component if that's clean). It lists each host the project is set up on (host label and path), with a "Remove from <host>" `Button` that opens the store's remove-from-host confirm.
   - Add a "Keep separate…" `Button` behind a `ConfirmDialog` ("Split <name> into a separate project per host? Manor won't join them again."), which calls `keepSeparate`.
   - Remove the "Link with" select, the per-member Unlink and "Unlink all".
   - In `ProjectSettingsPage.tsx`, remove the member page's Unlink button (around line 643).
5. Delete the store's `linkLocalFolder` and any other link actions nothing calls any more. Run `pnpm knip:ci` to find them. Update or delete their tests.
6. Follow `.claude/rules/ui-components.md`.

## Files to touch
- `src/components/hosts/CloneToHostDialog.tsx`, `TransferDialogHost.tsx`, `CloneToHostDialog.test.ts`
- `src/components/sidebar/NewWorkspaceDialog/HostPicker.tsx`, `NewWorkspaceDialog.tsx`
- `src/lib/workspace-host-choices.ts` and its tests
- `src/components/settings/ProjectHostSection/ProjectHostSection.tsx`
- `src/components/settings/ProjectLinksSection.tsx`, `ProjectSettingsPage.tsx`
- `src/store/project-store.ts` and the affected tests
