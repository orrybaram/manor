---
title: transferTargets helper and transferProject store action
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# transferTargets helper and transferProject store action

Implement the "Renderer" helper and store parts of ADR-213.

## Steps
1. New `src/lib/transfer-targets.ts`: `transferTargets(project, projects, hosts, mode)` → `{ hostId, label, disabledReason }[]`.
   - List `LOCAL_HOST_ID` ("This machine") first, then every remote host, minus the project's current host.
   - Disabled reasons:
     - The host's last connect failed. Reuse the `describeHost` text from `hostsToCloneOnto` in `workspace-host-choices.ts`.
     - Copy: the group already has a member on that host ("Already on <label>").
     - Move: another group member already lives there.
   - Unlinked projects get targets too.
   - Add unit tests next to the existing tests for `workspace-host-choices`.
2. New `src/lib/project-panes.ts`: move `projectHasOpenPanes` here from `ProjectHostSection.tsx` and update the import.
3. `src/store/project-store.ts`:
   - `transferProject(projectId, hostId, mode, overrides?)`:
     1. Show a persistent loading toast with `useToastStore` ("Copying <name> to <host>…" or "Moving…"). Update its `detail` from `window.electronAPI.projects.onCloneProgress` with the last progress line, and unsubscribe when done.
     2. Call `projects.transfer`.
     3. On `ok`:
        - Change the toast to success ("<name> is on <host>").
        - Refresh projects the way `cloneIntoGroup` and `moveProjectToHost` do today.
        - For a remote target, run `hosts.healthCheck(hostId, project.path)` in the background. On failure, add a toast with an "Open settings" action.
     4. On `needsInput`: remove the toast and set `transferDialog` state.
     5. On a throw: show an error toast with a "Choose location…" action that sets `transferDialog` with reason `"failed"` and the planned values. If no plan is available, use empty values.
   - `transferDialog` state with `openTransferDialog` and `closeTransferDialog`.
   - Rewrite `cloneIntoGroup` as a thin wrapper over `projects.transfer(..., "copy", { repoUrl, targetDir })`. Keep its signature so `CloneToHostDialog` and its tests keep working. Update `project-store-clone-into-group.test.ts`.
   - Add a test file `src/store/__tests__/project-store-transfer.test.ts`: toast lifecycle, `needsInput` opens the dialog state, and an error toast on a throw.

## Files to touch
- `src/lib/transfer-targets.ts` (new) and its test
- `src/lib/project-panes.ts` (new)
- `src/components/settings/ProjectHostSection/ProjectHostSection.tsx`: import only
- `src/store/project-store.ts`
- `src/store/__tests__/project-store-transfer.test.ts` (new)
- `src/store/__tests__/project-store-clone-into-group.test.ts`
