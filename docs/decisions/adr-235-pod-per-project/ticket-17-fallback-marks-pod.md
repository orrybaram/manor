---
title: The Set up on fallback path marks the pod as the project's
status: in-progress
priority: high
assignee: opus
blocked_by: []
---

# The Set up on fallback path marks the pod as the project's

Decided 2026-10-15 after review. When "Set up on ▸ In a new pod" returns
`{ok:false, stage:"clone", needsInput}`, the renderer opens the transfer
fallback dialog (`TransferDialogHost`/`CloneToHostDialog`) on the kept pod. It
finishes through `projects.transfer` with overrides, so `forProject` is never
set. The pod then shows in other projects' host lists, and Remove doesn't
offer to delete it.

Fix it on the main side, so every client gets it:
- `openInNewHost`'s `retryFrom` accepts `{hostId, stage: "clone", overrides?:
  {repoUrl, targetDir}}`, and passes the overrides to
  `transferProject` / `cloneProject`. Then, as on the normal path, it sets
  `forProject` and calls `recordChanged`.
- The renderer: when the fallback dialog was opened for a pod from
  `openInNewHost` (the store knows: `runOpenInNewHost` opens it), its submit
  calls `openInNewHost` with that `retryFrom` instead of `projects.transfer`.
  Carry the profile/source ids through the dialog request.
- Only mark a host that `openInNewHost` made with this profile (`profileId`
  matches, `forProject` unset). Never re-mark a host that belongs to another
  project.
- Tests: main (overrides passed through, forProject set, a foreign host
  refused) and store (fallback submit goes through openInNewHost).

## Files to touch
- `electron/projects/new-host-for-project.ts` + test
- `electron/bridge/handlers/projects.ts` (input validation for overrides)
- `src/store/project-store.ts`, `src/components/hosts/TransferDialogHost.tsx`, `src/components/hosts/CloneToHostDialog.tsx` + store test
