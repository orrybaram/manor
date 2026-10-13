---
title: Owner channel, manifest and layout sync from the desktop
status: done
priority: critical
assignee: opus
blocked_by: [2]
---

# Owner channel, manifest and layout sync from the desktop

ADR-225 D4 and D5 (layout part).

## Box side
- `manor-host server-bridge`, modelled on `runRemoteBridge` (`electron/terminal-host/bridge.ts`):
  - Read `~/.manor/remote/server/owner-token`.
  - Send `hello { token, role: "owner" }`.
  - Pipe stdio to `server.sock`.
- The host server's bridge accepts the owner hello. Add `callerClass: "owner"` to `BridgeConnection` (`electron/bridge/types.ts`). Owner may call LOCAL_ONLY methods; device may not (`server.ts:254`).
- Owner-only methods:
  - `hostServer.syncManifest(manifest)`:
    - `manifest` holds the host's projects, with `hostId` rewritten to `local`, their `workspaceNames`, `workspaceIssues` and display settings.
    - It also carries an integration snapshot (ADR-225 D8): for each workspace, the linked issue (id, title, URL) and the PR (number, state, checks) the desktop already has, with a `takenAt` timestamp. Re-send it when the desktop's PR or issue data changes.
    - The host server makes no integration calls. The `integrations` namespace and issue image fetches answer `unavailable:host`.
    - It is persisted in `dataDir/manifest.json`.
    - The `projects` reads serve it, plus workspaces from `git worktree list` on each project path.
  - `hostServer.syncLayout(snapshot)`:
    - Layout v3 filtered to workspace keys `<hostId>:<path>` for this host, rewritten to bare `<path>`.
    - Persisted in `dataDir/layout.json`.
  - `hostServer.status()`.

## Desktop side
- `HostServerClient` (new, `electron/backend/host-server-client.ts`):
  - Opens a second stream on the host's `HostTransport`, running `exec manor-host server-bridge`.
  - Speaks bridge frames, so it can reuse the frame codec in `electron/bridge/`.
- The backend registry owns one per remote host, next to `RemoteBackend`. It reconnects on that host's reconnect events and, after every connect, re-sends the manifest and layout.
- Manifest changes are pushed when `ProjectManager` changes a project on that host (debounced).
- Layout changes are pushed on the `LayoutStore` save debounce, for hosts whose keys appear in the change.
- A host with an older tarball (no `server-bridge`) fails quietly: the client is marked unsupported until the next bootstrap.

## Files to touch
- `electron/terminal-host/index.ts` (argv), `electron/terminal-host/bridge.ts` or a new `server-bridge.ts`
- `electron/bridge/types.ts`, `electron/bridge/server.ts`
- `electron/host-server/owner.ts` (new)
- `electron/backend/host-server-client.ts` (new), `electron/backend/registry.ts`
- `electron/app-lifecycle.ts`: wire the manifest and layout push
