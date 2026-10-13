---
title: Adopt a host's projects, agents and layout onto the box
status: done
priority: critical
assignee: opus
blocked_by: [5]
---

# Adopt a host's projects, agents and layout onto the box

ADR-227 D3.

## Host side
- `hostServer.adopt(bundle: AdoptionBundle)` is owner-only. The bundle is:
  - `projects: ManifestProject[]`
  - `agents: AgentInfo[]`
  - `layout: Record<path, LayoutEntry>` plus `lastActiveWorkspacePath`
- Validate the bundle with an `assertAdoptionBundle` in `owner.ts`, then
  **merge by id**:
  - Projects merge by `id`. Workspace-keyed records merge per path.
  - Agents merge by `id`.
  - Layout merges per workspace path.
  - **The host wins on conflict.**
- Write all three stores, then set `ownership: "host"` last. Return the new
  status.
- Calling it again is harmless: the same merge applies.

## Desktop side
- In `HostServerSync`, or a new `electron/backend/host-adoption.ts`, on each
  owner connect read `status().ownership`:
  - **`pending`:** build the bundle and send it.
    - Projects come from `projectManager.manifestRecords(hostId)`, which
      already drops `hostPaths` and resolves group shared fields.
    - Agents come from `agentManager` entries with `agentHostId === hostId`.
    - Layout comes from `hostLayoutSnapshot()` / `layoutSnapshotFor()`
      (`electron/backend/host-server-sync.ts:355,381`).
  - **`host` and the local copy is not adopted yet:** if local entries
    remain, send them once through the same merge, so they are added and
    never overwrite.
- **Only after the ack:**
  1. Write `~/.manor/backups/pre-adr-227-<hostId>.json` holding the removed
     records.
  2. Remove the host's projects from `projects.json`. **Keep the project ids
     in groups' `memberIds`.**
  3. Remove the host's agents from `agents.json`.
  4. Remove the `<hostId>:*` layout entries.
  5. Set `PersistedHost.adopted = true`.
- **A crash between ack and cleanup** must finish on the next connect. Add a
  test.
- **A never-connected host** with no local records sends an empty bundle.

## Tests
- Round trip: seed a desktop `projects.json`, `agents.json` and `layout.json`
  with two hosts, adopt one, and compare the host's stores and the desktop's
  remaining stores.
- Conflict: the host wins.
- Resend is idempotent.
- Crash recovery.

## Files to touch
- `electron/host-server/owner.ts`
- `electron/host-server/handlers.ts`
- `electron/host-server/adopt.ts` (new)
- `electron/backend/host-adoption.ts` (new)
- `electron/backend/host-server-sync.ts`
- `electron/projects/types.ts`: `PersistedHost.adopted`.
- `electron/projects/project-manager.ts`: remove a host's records, keeping
  group member ids.
- `electron/agent-persistence.ts`
- `electron/terminal-host/layout-persistence.ts`

## Carried over from ticket 5
- **`adopt` must update the live stores.** It writes into the
  `ProjectManager`, `LayoutStore` and agent store instances the server holds
  in memory, not only the files on disk. It sets ownership last, through
  `OwnershipState.set` (`electron/host-server/ownership.ts`). After that,
  `projects.changed` and `layout.changed` must be published, so a connected
  phone sees the adopted state.
- **Reuse the slice-1 helpers.** These were kept for this ticket:
  - the `ManifestProject` and `HostLayoutSnapshot` types;
  - `assertManifestProject` and `assertBareLayoutEntries` in `owner.ts`;
  - `hostLayoutSnapshot` and `layoutSnapshotFor` in
    `electron/backend/host-server-sync.ts`.
- **Test helpers.** The harness's `h.adopt()` and
  `HostServerInternals.ownership` flip the state directly. Keep them, or
  build them on top of `hostServer.adopt`.
