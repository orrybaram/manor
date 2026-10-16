---
title: "In a new pod" targets in Add Project, Set up on and New Workspace
status: todo
priority: critical
assignee: sonnet
blocked_by: [2, 3]
---

# "In a new pod" targets in Add Project, Set up on and New Workspace

ADR-235 D4.

- `AddProjectDialog.tsx` (Clone repository mode): add a "New pod" group to
  the host `SearchableSelect`, with one option per profile:
  - "In a new pod · <profile>" for kubernetes;
  - "In a new container · <profile>" for docker.
  With no profiles, show "In a new pod…", which opens the profile editor
  (ticket 2) and selects the saved profile. When a profile option is picked,
  hide Location. Submit calls `projects.openInNewHost`.
- `src/lib/transfer-targets.ts`: add profile targets after the hosts, as
  `{kind:"newHost", profileId, label}`. `ProjectSetUpMenu.tsx` and
  `NewWorkspaceDialog/HostPicker.tsx` render them and call `openInNewHost`
  with `sourceProjectId`.
- Store: `project-store.ts` gets `openInNewHost(...)`, mirroring
  `transferProject`: a loading toast, the `needsInput` fallback dialog, and a
  success toast. On `{ok:false}`, show the error with Retry (`retryFrom`)
  and "Delete the pod", which calls `removeHost(hostId, true)` after the
  existing typed confirm in `RemoveHostDialog`.
- `useHostCloneFlow.ts` / `HostCloneSteps.tsx`: a first step "Starting
  <profile> pod" that shows `host.progress` / the status detail from
  `useHostStore`, then the existing steps.
- Tests: transfer-targets unit tests, plus dialog tests for the new options.

## Files to touch
- `src/components/sidebar/AddProjectDialog/AddProjectDialog.tsx`
- `src/lib/transfer-targets.ts` + test
- `src/components/sidebar/ProjectSetUpMenu.tsx`
- `src/components/sidebar/NewWorkspaceDialog/HostPicker.tsx`
- `src/store/project-store.ts`
- `src/components/hosts/useHostCloneFlow.ts`, `HostCloneSteps.tsx`
