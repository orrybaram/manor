---
title: Host profiles — model, storage, perHost fields and IPC
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Host profiles — model, storage, perHost fields and IPC

ADR-235 D1. **Prerequisite outside this ADR:** ADR-234 ticket 4 (typed
template fields and `hosts.checkTemplate`) must be merged first. Rebase on it.

- Add `HostProfile` (see D1) to `electron/projects/types.ts` and
  `PersistedState.hostProfiles?: Record<string, HostProfile>`.
- Add `PersistedHost.profileId?: string` and `PersistedHost.forProject?: string`
  (used by tickets 3, 5, 6, 7). Make sure load and save keep them, and that
  `HostRecords` exposes setters.
- New `electron/projects/host-profiles.ts`, modelled on `host-records.ts`, with
  list/get/save/remove. Saving validates the values against the template:
  run `template.recipe({...values, name: "probe"})` and expect no throw.
  Values for `perHost` keys are refused.
- `RecipeTemplate.perHost: string[]` in `recipe-templates/types.ts`. Set it to
  `["name"]` in `docker.ts` and `kubernetes.ts`, and to `[]` in `custom.ts`
  if custom is a template. `listTemplates` returns it.
- `idleStopMinutes` must be one of 30/60/120, or absent. It defaults to 60
  when a profile is created.
- New `electron/bridge/handlers/host-profiles.ts`: `hostProfiles.list`,
  `save`, `remove`, all `localOnly`, registered like `hosts.ts`. Expose them
  in the preload and `window.electronAPI` types. Removing a profile clears
  `profileId` on its hosts.
- `signIn` metadata is part of the type, but nothing writes it until ticket 9.
- Unit tests: round-trip persistence, validation, refusal of perHost keys,
  and that remove clears host `profileId`.

## Files to touch
- `electron/projects/types.ts` — HostProfile, PersistedState.hostProfiles, PersistedHost.profileId/forProject
- `electron/projects/host-profiles.ts` (new) + test
- `electron/projects/host-records.ts` — profileId/forProject accessors
- `electron/backend/providers/recipe-templates/types.ts`, `docker.ts`, `kubernetes.ts` — `perHost`
- `electron/bridge/handlers/host-profiles.ts` (new), handler registration, preload, `src/` electronAPI types
