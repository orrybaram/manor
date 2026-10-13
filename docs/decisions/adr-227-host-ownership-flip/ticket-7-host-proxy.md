---
title: Owner-channel events and a per-host HostProxy with cache
status: done
priority: critical
assignee: opus
blocked_by: [5]
---

# Owner-channel events and a per-host HostProxy with cache

ADR-227 D4 (events and offline cache).

## Do
- **Event frames in `HostServerClient`.** Teach
  `electron/backend/host-server-client.ts` the bridge's subscribe and event
  frames. Today it handles results only (`invoke` at :194). Use the same
  frame shapes the web transport uses (`src/bridge/transports/ws.ts`,
  `electron/bridge/types.ts`). Resubscribe after a reconnect.
- **`HostProxy`.** Create `electron/backend/host-proxy.ts`, one per remote
  host, owned next to the `HostServerClient` in `RemoteHostConnection`.
  - **On connect** it fetches `projects.getAll`, `layout.getAll` and
    `agents.getAll`, then subscribes to `projects.changed`, `layout.changed`,
    `agents.updated` and the chat events.
  - **Rewriting.** It republishes into the desktop's `BroadcastBus` with:
    - bare paths turned into `workspaceKey(hostId, path)`
      (`src/lib/workspace-key.ts:76`);
    - `hostId` stamped onto `ProjectInfo` and `AgentInfo`.
  - **Calls.** It exposes `invoke(ns, method, args)` with the reverse
    rewrite: key to bare path, hostId to `local`.
  - **Cache.** It keeps the last projects, agents and layout in
    `~/.manor/host-cache/<hostId>.json` (atomic writes) and serves them while
    the host is away.
  - It exposes `ready: Promise<void>`, which resolves at the first snapshot.
- **Unit tests** against the host-server test harness (`useHostServerHarness`):
  - event fan-out with rewriting
  - reconnect and resubscribe
  - serving from cache while disconnected

## Files to touch
- `electron/backend/host-server-client.ts`
- `electron/backend/host-proxy.ts` (new)
- `electron/backend/host-connection.ts`
- `electron/backend/registry.ts`: add `hostProxy(hostId)`.
- `electron/paths.ts`: add `hostCacheFile`.
- `electron/backend/__tests__/host-proxy.test.ts` (new)

## Carried over from ticket 5
- **Host display name.** The hello's host name is now the box's own
  `os.hostname()`, so the desktop's alias for the host no longer reaches the
  host server. The proxy should label the host with the desktop's alias
  (`HostRecords.label`) when it republishes. It must not use the box's
  hostname.
