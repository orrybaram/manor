---
title: Delete desktop journal replay, manifest sync and remote polling
status: todo
priority: high
assignee: sonnet
blocked_by: [8]
---

# Delete desktop journal replay, manifest sync and remote polling

ADR-227 D4 (Deleted on the desktop).

## Delete
- **Remote journal replay on the desktop:**
  - `HostHookFeed` construction and use in `RemoteHostConnection`
    (`electron/backend/host-connection.ts:344, 380-391, 460, 493, 502, 558,
    586`)
  - `catchUpHooks` for remote hosts
  - `hookSeqStore` in the `BackendRegistry` ctx (`electron/app-lifecycle.ts`
    and `electron/server/*`)
  - `registry.setHookSink`'s remote catch-up
- `ProjectManager.get/setHostHookCursor` and `flushHostHookSeqs`.
- `HostRecords.hookCursor` / `setHookCursor`.
- **`PersistedHost.lastHookSeq` and `hookJournalEpoch`.** Drop them on load
  in `StateStore`.
- **`HookJournalPtyBackend` and the desktop `DaemonPtyBackend.replayHooks`.**
  The box's `TerminalHostClient.replayHooks` and `HostHookFeed` stay, used by
  the host server.
- **`RemoteWorktreePoller`** (`electron/projects/worktree-watcher.ts:150`)
  and remote use of `LastKnownWorkspaces` (`project-info.ts:92`). The proxy
  cache replaces them.
- **`HostServerSync` manifest and layout sends**: `buildHostManifest`,
  `manifestChanged`, `layoutPersisted`, and the `onPrCacheChange` wiring.
  Keep the VAPID keys, push endpoints and `pairingChanged`.
- **`electron/host-server/__tests__/two-readers.test.ts`.** Retire it, and
  replace it with a test that the desktop's merged `agents.getAll` equals
  the host's after a status change.

## Change
- **Host-resumed announcement** (`host-connection.ts:574-626`, which feeds
  `hosts.reconnected`): wait for `hostProxy.ready`, not for a hook catch-up.
- **Desktop notifications and dock badge for remote agents:** drive them
  from the proxy's `agents.updated` transitions into the same
  `maybeSendNotification` path. The push dedupe stays.

## Files to touch
- `electron/backend/host-connection.ts`
- `electron/backend/registry.ts`
- `electron/backend/hook-feed.ts`: keep it, now used by the box only.
- `electron/backend/types.ts`
- `electron/backend/daemon-pty.ts`
- `electron/projects/project-manager.ts`
- `electron/projects/host-records.ts`
- `electron/projects/state-store.ts`
- `electron/projects/types.ts`
- `electron/projects/worktree-watcher.ts`
- `electron/projects/project-info.ts`
- `electron/backend/host-server-sync.ts`
- `electron/app-lifecycle.ts`
- `electron/server/create-manor-server.ts`
- Tests:
  - `electron/backend/__tests__/registry.test.ts`
  - `electron/backend/__tests__/hook-feed.test.ts`
  - `electron/host-server/__tests__/two-readers.test.ts`

## Carried over from ticket 5
- **Code with no production caller left.** With the manifest gone, these are
  unused: `GitHubManager.cachedPr` and `onPrCacheChange`,
  `ProjectManager.knownWorkspaces`, and the "manifest snapshot" comments in
  `github.ts` and `project-info.ts`. Delete them, unless ticket 8's merged
  reads need `knownWorkspaces`.

## Carried over from ticket 6
- **Agents written after adoption stay on the desktop.** After the first
  adoption, the desktop's own hook feed keeps writing agents for that host
  locally, and they are never handed over. Deleting the desktop replay stops
  new ones. Also drop any of these leftovers on load: remote agents of an
  `adopted` host.

## Carried over from ticket 7
- **Republish agents.** Turn on `republishAgents: true` in the desktop's
  `HostProxyContext` (`createManorServer`) once the desktop replay is
  deleted.
- **Readiness per connection.** `proxy.ready` resolves only at the first
  snapshot ever. The resume announcement needs one per connection: add a
  "next snapshot" promise, or a `snapshotted` event.
