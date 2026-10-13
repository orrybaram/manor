---
title: Host server owns its projects, workspaces and layout
status: todo
priority: critical
assignee: opus
blocked_by: [3, 4]
---

# Host server owns its projects, workspaces and layout

ADR-227 D2 and D6 (the host table).

## Do
- **Real stores.** The host server's composition now uses a real
  `ProjectManager` and a real `LayoutStore` (via `createManorServer`), with
  `projects.json` and `layout.json` in the server data dir. Every project is
  `hostId: "local"`.
- **Ownership state.** Add `ownership: "pending" | "host"`, persisted in
  `ownership.json`, and report it in `hostServer.status()`. While the state
  is `pending`:
  - `projects.getAll` is empty;
  - project and layout writes answer `unavailable:host` with "This host is
    being set up".
  
  Ticket 6 adds `hostServer.adopt`. Until then, a test helper can flip the
  state.
- **`HOST_TABLE` allows these** (`electron/host-server/handlers.ts`), all as
  shared handlers:
  - `projects.*` writes for workspaces:
    - `createWorktree`, `removeWorktree`
    - rename workspace, reorder, folders (create, rename, move, delete,
      assign), hidden
    - `linkIssueToWorkspace` / `unlink`
    - `listLocalBranches`, `listRemoteBranches`
  - `layout.apply`, `setPendingCommand`, `setPaneTitle`, `reportViewport`
  - `agents.setPaneContext`
  - `pty.create`, which now spawns (delete the attach-only `hostPtyCreate`)
- **Owner-only methods** (`localOnlyCallers: ["owner"]`): `projects.add`,
  clone, project update and delete, and group shared-field writes. A device
  can't add a repository to a box.
- **Delete:**
  - `hostServer.syncManifest` and `syncLayout`
  - `OwnerSnapshotStore`, `owner-snapshot.ts`
  - `manifest.ts`'s `manifestProjects`. Keep the `ManifestProject` type for
    adoption.
  - `assertHostLayoutSnapshot`
  - `paneContextFrom`
  - `started-while-away.ts`
  - `integrationSnapshot`
  
  Update `owner.ts` to match.
- **Update the tests:**
  - `boot-and-agents.test.ts:120-146`: the unavailable list, and replace
    "never spawns" with "spawns"
  - `owner-channel.test.ts`
  - `winsize-and-away.test.ts:397-407`
  
  Add a test where a device creates a worktree and launches an agent with no
  owner connected.

## Files to touch
- `electron/host-server/server.ts`
- `electron/host-server/handlers.ts`
- `electron/host-server/owner.ts`
- `electron/host-server/owner-snapshot.ts` (delete)
- `electron/host-server/manifest.ts`
- `electron/host-server/started-while-away.ts` (delete)
- `electron/host-server/layout.ts`
- `electron/paths.ts`: the `hostServerPaths` entries for projects, layout
  and ownership.
- `electron/host-server/__tests__/*`
