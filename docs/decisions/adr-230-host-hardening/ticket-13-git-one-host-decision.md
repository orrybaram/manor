---
title: Git runs on the host of the project the route resolved (#269)
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Git runs on the host of the project the route resolved (#269)

ADR-230 D13 (gap R9, GitHub issue #269).

## What to build

- In `electron/routes/git.ts`, `resolveGit` (:69-85) returns
  `git: deps.backendRegistry.get(normalizeHostId(match.project.hostId)).git`
  instead of `deps.backend.git`.
  - `backendRegistry` is on `HostDeps` (`electron/ipc/types.ts:67`).
  - The precedent is `electron/bridge/handlers/hosts.ts:263`.
  - Update the header comment (:11-15).
- Keep `resolveProjectByPath`'s fallback as it is.
- Check what `backendRegistry.get` does for an away or unregistered host,
  and make the route answer as `RoutedBackend.git` would today, with the
  same error and status code. Add a guard if they differ.

## Tests (each must fail on the base commit)

In `electron/routes/git.test.ts`:
- `deps()` (:103-117) gains `backendRegistry: { get: (hostId) => ({ git:
  gits[hostId] }) }`, with a separate `makeGit()` per host.
- The issue's scenario (:267-298) now also asserts that `getFullDiff` ran
  on the **local** fake and not the box fake.
- A new test: a cwd inside the box project's loaded workspace runs on the
  box fake, with the box project's default branch.
- An away host gives the same error as before.

## Files to touch
- `electron/routes/git.ts`
- `electron/routes/git.test.ts`

Close #269 in the PR body.
