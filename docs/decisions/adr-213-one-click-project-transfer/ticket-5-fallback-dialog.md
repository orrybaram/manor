---
title: Fallback dialog — local targets, prefill, copy mode
status: done
priority: medium
assignee: sonnet
blocked_by: [3, 4]
---

# Fallback dialog: local targets, prefill, copy mode

Implement the "Fallback dialog" part of ADR-213.

## Steps
1. `src/components/hosts/CloneToHostDialog.tsx`:
   - Add `mode: "copy"`. Both `copy` and `move` submit through `transferProject(projectId, hostId, mode, { repoUrl, targetDir })`. Keep `addToGroup` working for `NewWorkspaceDialog` through the `cloneIntoGroup` wrapper, or point it at `copy`, whichever is simpler.
   - New optional props: `initialHostId`, `initialRepoUrl`, `initialDir`, `reason`.
     - Show a short banner per reason:
       - `no-origin`: "This project has no origin remote — enter the repo URL."
       - `dir-taken`: "That folder is already used — pick another."
       - `failed`: "The clone failed — check the location and try again."
     - With no `initialDir`, keep today's `~/code/<slug>` default, using the moved `toDirSlug`.
   - Allow `LOCAL_HOST_ID` in host choices ("This machine"). Skip the health-check step for local, as `AddProjectDialog` does (`skipHealthChecks`). Relabel "Remote directory" as "Directory" when local.
2. Mount one `CloneToHostDialog` in the sidebar root, or wherever other app-wide dialogs mount. Drive it from `transferDialog` store state, and give it a new `key` for each opening, as its doc comment requires. Build host choices with `transferTargets`.
3. `ProjectHostSection.tsx`:
   - Picking a remote host, or using "Clone onto host…", calls `transferProject(project.id, hostId, "move")` instead of opening the dialog directly. The one-click path opens the dialog only when it needs input.
   - Picking local also goes through `transferProject`, so a missing local checkout is cloned instead of failing.
   - Keep the "Choose local folder…" escape hatch.
   - Fix "Clone onto host…" showing up for local projects: it should call transfer for the chosen host.
4. Update the existing dialog and ProjectHostSection tests that break, and add one for local-target copy.

## Files to touch
- `src/components/hosts/CloneToHostDialog.tsx`
- `src/components/hosts/HostCloneSteps.tsx` (label only)
- sidebar root or app dialog mount point
- `src/components/settings/ProjectHostSection/ProjectHostSection.tsx`
- related tests
