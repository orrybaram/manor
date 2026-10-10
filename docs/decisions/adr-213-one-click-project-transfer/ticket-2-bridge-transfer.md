---
title: Bridge projects.transfer and local-capable moveToHost
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Bridge projects.transfer and local-capable moveToHost

Implement the "Bridge" section of ADR-213.

## Steps
1. `electron/bridge/handlers/projects.ts`:
   - Add a `projectsTransfer` handler that takes `{ projectId, hostId, mode, repoUrl?, targetDir? }` and validates the input the same way the neighbouring handlers do.
     - Call `deps.backendRegistry.ensureConnected(hostId)` only when `hostId !== LOCAL_HOST_ID`, the same as `projectsClone` (around line 115).
     - Call `projectManager.transferProject(...)` and return its `TransferResult`.
   - Register it as `transfer` next to `clone` and `moveToHost` (around lines 493-500).
   - In `projectsMoveToHost`: remove `assertRemoteHost`, use `assertKnown` or the equivalent, and call `ensureConnected` only for remote hosts.
2. Expose `projects.transfer` in the preload, in the same place `projects.clone` and `moveToHost` are exposed (find it with grep), and in the `src/electron.d.ts` types.
3. Tests: extend `electron/bridge/handlers/__tests__/projects-host-validation.test.ts`:
   - `transfer` validates its input.
   - `transfer` doesn't call `ensureConnected` for local.
   - `moveToHost` now accepts local.

## Files to touch
- `electron/bridge/handlers/projects.ts`
- preload bridge file that lists `projects.*` methods
- `src/electron.d.ts`
- `electron/bridge/handlers/__tests__/projects-host-validation.test.ts`
