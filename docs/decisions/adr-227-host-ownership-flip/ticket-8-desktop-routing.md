---
title: Desktop routes remote-host calls to the host server
status: todo
priority: critical
assignee: opus
blocked_by: [6, 7]
---

# Desktop routes remote-host calls to the host server

ADR-227 D4 (routing, merged reads, control and data plane).

## Do
- **Route rules.** Add a `route` rule to `method()` (`electron/bridge/method.ts:66,95`):
  `byProject(argIndex)`, `byWorkspaceKey(argIndex)`, `byPane(argIndex)` and
  `byGhRepo(argIndex)`.
  - Each resolves to a hostId: by project, via `ProjectInfo.hostId` from the
    merged list; by key, via `parseWorkspaceKey`; by pane, via the layout key
    that holds it.
  - `toHandlerTable` collects them.
- **Forwarding in `BridgeServer.dispatch`** (`electron/bridge/server.ts`).
  Only the desktop table gets a `forward` hook. For a remote hostId, it calls
  `registry.hostProxy(hostId).invoke(...)`.
  - **Host away:** answer `unavailable:host-away`, with copy that names the
    host.
  - **Local:** handle as today.
- **Routes on the shared methods:**
  - `projects.*` workspace methods: `byProject`
  - `layout.*`: `byWorkspaceKey`, or `byPane` for `setPendingCommand` /
    `setPaneTitle`
  - `agents.setPaneContext`: `byPane`
  - `pty.create` for remote panes (D4's control plane):
    - The host spawns the session.
    - The desktop then attaches through `RemoteBackend.pty.attachExisting`
      over the daemon stream, as today.
    - Keep data-plane methods (`write`, `resize`, `attach`) on the daemon
      path.
- **Merged reads.** `projects.getAll`, `layout.getAll` /
  `getLastActive`, and `agents.getAll` / `get*` merge local results with
  every proxy's (cache when away).
- **`ProjectManager` on the desktop now holds local projects only.**
  - Remote project ids exist only in groups' `memberIds`.
  - `remoteProjectHostPaths`, `knownWorkspaces` and `hostIdForPath` read from
    the proxies.
  - Group shared-field edits fan out to each remote member as
    `projects.update` through its proxy.
- **Moves and transfers.** `host-move.ts` and `host-transfer.ts` call the
  source and target hosts' project methods through proxies, not
  `projects.json`.
- **Surface test.** For each routed namespace (`projects`, `layout`,
  `agents`, `github`), every method must declare `route` or be explicitly
  marked `local`.
- Build only after ticket 6 has adopted the records, so the desktop never
  holds both copies.

## Files to touch
- `electron/bridge/method.ts`
- `electron/bridge/server.ts`
- `electron/bridge/handlers/projects.ts`
- `electron/bridge/handlers/layout.ts`
- `electron/bridge/handlers/agents.ts`
- `electron/bridge/handlers/pty.ts`
- `electron/backend/routed-backend.ts`
- `electron/projects/project-manager.ts`
- `electron/projects/project-groups.ts`
- `electron/projects/host-move.ts`
- `electron/projects/host-transfer.ts`
- `electron/projects/project-info.ts`
- `electron/server/create-manor-server.ts`
- `electron/bridge/__tests__/routes-surface.test.ts` (new)
