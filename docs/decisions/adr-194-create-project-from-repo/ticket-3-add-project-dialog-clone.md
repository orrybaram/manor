---
title: Add Project dialog - clone a repository onto any host
status: todo
priority: high
assignee: opus
blocked_by: [1, 2]
---

# Add Project dialog: clone a repository onto any host

See ADR-194 §3 for the layout.

- `AddProjectDialog.tsx`: top `ToggleGroup` becomes `Open folder` /
  `Clone repository` (mode `"folder" | "clone"`). Folder mode = today's local
  "Choose Folder…" flow, unchanged.
- Clone mode fields:
  - **Host**: `SearchableSelect` with "This Mac" (`LOCAL_HOST_ID`) first, then
    `remoteHostOptions(hosts)`. Default This Mac.
  - **Repository**: `SearchableSelect` over `window.electronAPI.github.listRepos()`
    (fetched once when clone mode is first shown; `loading` while pending;
    label `nameWithOwner`, private repos marked). Picking one sets the URL
    field to `cloneUrl`. Below it, the existing Repo URL `Input` for pasting
    any URL; editing it clears the picked repo. Hide the picker if the list
    comes back empty.
  - **Location**: `Input` plus, for This Mac only, a `Browse…` `Button`
    (`dialog.openDirectory`, sets `<picked>/<repoName>`). Default is
    `<parent>/<repoName>` where parent = dirname of the most recently added
    project on the chosen host (from the project store), else `~/code`.
    Follows repo name/host changes until the user edits it.
  - **Name**: as today, derived from the repo until edited.
  - Split `RepoUrlAndRemoteDirFields` in `HostCloneSteps.tsx` as needed so
    `CloneToHostDialog` keeps working; label "Location" here, "Remote
    directory" there.
- On Clone: `useHostCloneFlow` with `run` = `cloneProject({ hostId, repoUrl,
  targetDir, name })`. For the local host, skip the health step: add a
  `skipHealthChecks` (or similar) option to `useHostCloneFlow`, and on success
  close the dialog and call a new `onLocalProjectCloned(project)` prop.
  Remote: unchanged health step + `onRemoteProjectAdded`.
- `src/App.tsx`: wire `onLocalProjectCloned` to select the project and open
  `ProjectSetupWizard` (reuse the `openWizardForLatestProject` logic, keyed by
  project id). Allow opening the dialog directly in clone mode (e.g.
  `initialMode` prop).
- `src/components/command-palette/useCommands.tsx`: add "Clone Repository…"
  that opens the Add Project dialog in clone mode (follow how "Add Project" is
  wired through `menu-commands`/`menu-handlers`).
- Use UI components only (`Button`, `Input`, `SearchableSelect`, `ToggleGroup`).
- Update/extend e2e or component tests that drive the Add Project dialog
  (`tests/e2e/remote-host.spec.ts`, fixtures) for the new toggle labels.

## Files to touch
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx`
- `src/components/hosts/HostCloneSteps.tsx`
- `src/components/hosts/useHostCloneFlow.ts`
- `src/App.tsx`
- `src/components/command-palette/useCommands.tsx` (+ menu-commands/handlers if needed)
- `tests/e2e/*` touching the dialog
