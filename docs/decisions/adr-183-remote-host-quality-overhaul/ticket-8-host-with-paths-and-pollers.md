---
title: Carry hostId with paths; one PerHostPoller
status: todo
priority: high
assignee: opus
blocked_by: [7]
---

# Carry hostId with paths; one PerHostPoller

Read `index.md`.

1. **`PerHostPoller<T>`.** Add it in `electron/per-host-poller.ts`.
   - Input: a list of `{ path, hostId }` entries, a
     `(hostId, paths) => Promise<T>` scan, an interval per host, and a
     merge-and-emit callback.
   - It owns the per-host `scanning` set, a generation guard against stale
     results, swallowing `HostUnavailableError`, and emitting only on change.
   - `PortScanner`, `BranchWatcher` and `DiffWatcher` use it. This fixes
     BranchWatcher's missing stale-tick guard; add a test for that.
   - Delete DiffWatcher's hand-rolled `groupPathsByHost`.
2. **Carry the host with the path.**
   - Watchers, the port scanner and `PrewarmManager` take entries or cwd with
     a `hostId`, instead of a `hostForPath` constructor parameter. Delete that
     parameter from all four constructors.
   - Get the host from where the workspace list is built:
     `ProjectManager`/`buildProjectInfo` already know each workspace's host.
   - Keep one `hostIdForPath` only where a bare path genuinely comes in from
     outside, e.g. a pty cwd with no known pane.
3. **Route once.**
   - `PortScanner` calls `registry.get(hostId).ports.scan(paths)` through
     `PerHostPoller`.
   - Delete `RoutedBackend`'s `scanPorts` fan-out and `scanNow`'s third copy
     of the allSettled/rethrow-local/warn-remote logic.
   - Always tag `ActivePort.hostId`, including `LOCAL_HOST_ID`, and remove the
     `port.hostId ? … : …` branches.
4. **`RemoteUrlResolver`** in `remote-forwards.ts, built from the scanner, the
   registry and the forwards.
   - Move in from `ipc/ports.ts`: `resolveForHost`, `whenHostReady`, the
     readiness state machine, rescan-on-unknown-port and the retry loop.
   - Delete the second `latestPorts` cache.
   - `enrichPorts` returns new objects instead of mutating the scanner's
     cached `ActivePort`s.
5. **`ipc/pty.ts`.**
   - Replace `unavailableHostFor` with
     `err instanceof HostUnavailableError && err.status !== "unknown"`. First
     confirm the error reaches the handler unwrapped.
   - `createOrAttach` returns the host it used, so `hostOf` goes.

Run `pnpm build` and the affected tests (ports, branch-watcher, diff-watcher,
prewarm, ipc).

## Files to touch
- `electron/per-host-poller.ts` (new)
- `electron/ports.ts`, `electron/branch-watcher.ts`, `electron/diff-watcher.ts`, `electron/prewarm-manager.ts`
- `electron/backend/routed-backend.ts`, `electron/remote-forwards.ts`
- `electron/ipc/ports.ts`, `electron/ipc/pty.ts`, `electron/app-lifecycle.ts`
- related tests
