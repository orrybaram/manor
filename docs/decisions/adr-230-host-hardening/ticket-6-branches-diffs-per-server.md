---
title: Branches and diffs are watched on each server and merged
status: done
priority: high
assignee: opus
blocked_by: [3]
---

# Branches and diffs are watched on each server and merged

ADR-230 D6 (gap R2). Read the ADR's D6 in full first.

## What to build

1. **Watchers on host servers.**
   - Build `BranchWatcher` and `DiffWatcher` in `createManorServer`
     (`electron/server/create-manor-server.ts`) instead of
     `electron/app-lifecycle.ts:289-292`.
   - Make the diff watcher's `mainWindow` dependency a platform option
     (`electron/bridge/handlers/branches-diffs.ts:55-63`). On the host it
     publishes over the bus only.
   - Add `branches` and `diffs` to the host server's allowlist
     (`electron/host-server/handlers.ts:470-620`).
   - Remove `diffs.start` from `DESKTOP_METHODS`
     (`electron/bridge/handlers.ts:41-45`) if the host now answers it.
2. **Per-connection watched sets.**
   - `BranchWatcher.start` (`electron/branch-watcher.ts:93`) and
     `DiffWatcher.start` keep `Map<connectionId, HostPath[]>` and watch the
     union.
   - `stop`, and a connection closing, remove that connection's entry. Hook
     the bridge's disconnect, as `releaseViewer` does in
     `electron/bridge/server.ts`.
   - Handlers pass `ctx.caller.id`.
3. **A `"split"` route kind** (`electron/bridge/routes.ts`):
   - It applies to `branches.start`, `branches.stop`, `diffs.start` and
     `diffs.stop`.
   - In `src/bridge/router.ts`, when not in pass-through, send each server
     the workspaces it answers for: `onlyKnownHosts` (:524) filtered by
     `answersFor`, then `toServerArgs`. Skip away servers.
   - Store the last requested set, and resend each server its share when it
     joins or comes back. Use the replay-on-join mechanism at :1110-1113.
   - A server answering `unavailable:host` (an older host server) has its
     workspaces given to a desktop that lists the host.
   - Update `electron/bridge/__tests__/routes-surface.test.ts`.
4. **Fan-out and re-key the events.**
   - Add `branches` and `diffs` to `FAN_OUT_NAMESPACES` (:160-164). Derive
     that from the new route kind rather than hard-coding it.
   - In `stampEvent` (:914-964), re-key each `Record<WorkspaceKey, …>`
     payload of `branches.changed`, `diffs.changed` and
     `diffs.fingerprintsChange` with `stampKey(entry, key)` (:427-435).
     Drop keys the entry doesn't answer for.
   - First write a failing test proving the current home-only path
     mis-keys on the phone (ADR-230 R2). If it turns out to be keyed
     correctly, say so in the ticket notes.

## Tests (each must fail on the base commit)

- `src/bridge/__tests__/router.test.ts`, in the phone describe (:795+, using
  `phone(desk, box)`):
  - `branches.start` sends `box` only its workspaces and `desk` only its
    own;
  - a `branches.changed` from `box` reaches the listener under the
    host-stamped key;
  - an away server is skipped and gets its share when it comes back;
  - the same for `diffs`.
- `electron/__tests__/branch-watcher.test.ts` (or the existing test file):
  two connections' sets are unioned, and one connection's stop leaves the
  other's.
- A host-server harness test: `branches.start` on a host server publishes
  `branches.changed` for a git repo in a temp dir.

## Files to touch
- `electron/branch-watcher.ts`, `electron/diff-watcher.ts`
- `electron/bridge/handlers/branches-diffs.ts`, `electron/bridge/handlers.ts`
- `electron/server/create-manor-server.ts`, `electron/app-lifecycle.ts`
- `electron/host-server/handlers.ts`
- `electron/bridge/routes.ts`, `electron/bridge/events.ts`, only if subscription names need it
- `src/bridge/router.ts`
- Tests named above.
