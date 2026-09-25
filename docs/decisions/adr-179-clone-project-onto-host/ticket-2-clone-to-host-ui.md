---
title: CloneToHostDialog and Project Settings host section wiring
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# CloneToHostDialog and Project Settings host section wiring

Read `docs/decisions/adr-179-clone-project-onto-host/index.md` first. This
ticket covers the "Renderer" section. Ticket 1 already added
`window.electronAPI.projects.moveToHost / getOriginUrl / pathExists` and
`useProjectStore().moveProjectToHost`.

Follow `.claude/rules/ui-components.md`: use `Button`, `Tooltip`, `Input` and
the rest from `src/components/ui/`, never raw `<button>`. Follow the `react`
skill conventions and the existing CSS-module styling.

## Steps

1. **Extract shared pieces** out of
   `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx` into
   `src/components/hosts/`:
   - `CloneProgressLog`: spinner, "Cloning…", and the last 8 progress lines.
     Keep `data-testid="clone-progress-log"`.
   - `HealthCheckList`: the header with "Re-run checks", the list of checks
     with ok/fail/unknown icons, and the "Fix in terminal" buttons. Keep
     `data-testid="health-check-list"`. Props: `checks`, `running`,
     `onRerun`, `onFix(check)`.
   - Move the CSS they need into their own modules. `AddProjectDialog` must
     render and behave exactly as before.
2. **`src/components/settings/CloneToHostDialog/CloneToHostDialog.tsx`** (plus
   a CSS module). Props: `open`, `project: ProjectInfo`, `hostId`, `onClose`,
   `onMoved?`. It follows the AddProjectDialog remote flow (Radix Dialog; steps
   form → cloning → health):
   - Form: the host label is read-only (the ssh target). "Repo URL" is
     pre-filled from `projects.getOriginUrl(project.id)` on open. "Remote
     directory" is pre-filled with `~/code/<slug of project.name>`. A short
     hint explains that the repo will be cloned (or an existing clone adopted)
     on the host, that this project will then run there, and that Manor
     doesn't copy keys. It has Cancel and Clone buttons, and shows any error
     inline.
   - Clone: subscribe to `projects.onWorktreeSetupProgress` for
     `step === "clone"`, the same way AddProjectDialog does, then call
     `moveProjectToHost`. On success, go to the health step and run
     `hosts.healthCheck(hostId, project.path)`.
   - "Fix in terminal" and "Done" behave as in AddProjectDialog. The dialog
     can't be closed while cloning.
3. **`src/components/settings/ProjectSettingsPage.tsx`, `ProjectHostSection`**:
   - Selecting a remote host (`kind: "switch"` to a non-local id) opens
     `CloneToHostDialog` for that host instead of calling `switchHost`. Keep
     the existing open-panes confirm in front of it. "Add new host…" still
     calls `addHost` and then opens the dialog for the new host id instead of
     switching.
   - Selecting Local still calls `updateProject({ hostId })`. Its error
     (ticket 1's guard) is already shown by `switchError`.
   - For a project whose `hostId` is remote, call
     `projects.pathExists(project.id)` on mount, when `project.path` or
     `hostId` changes, and when the host's status becomes connected. When the
     result is false, show a warning line (in the style of the existing
     `fieldHint`, colored `var(--yellow)`): "Repository not found on this
     host". Next to it, add a `Clone onto host…` button that opens the dialog
     for the current host.
4. Add a component test for `CloneToHostDialog` if the repo has a
   testing-library setup for similar dialogs. Check for existing
   `*.test.tsx` next to settings or sidebar components and match them.

Run `pnpm build` (typecheck included) and any affected vitest files.

## Files to touch
- `src/components/hosts/CloneProgressLog.tsx` and
  `src/components/hosts/HealthCheckList.tsx` (new), plus CSS modules
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx` and its CSS:
  use the extracted components
- `src/components/settings/CloneToHostDialog/CloneToHostDialog.tsx` and CSS
  (new)
- `src/components/settings/ProjectSettingsPage.tsx`: `ProjectHostSection`
  wiring
