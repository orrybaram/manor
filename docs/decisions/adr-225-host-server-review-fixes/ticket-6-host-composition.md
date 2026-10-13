---
title: Host server composition without nullables, OwnerSnapshotStore, hook-feed firstContact
status: in-progress
priority: high
assignee: opus
blocked_by: [5]
---

# Host server composition without nullables, OwnerSnapshotStore, hook-feed firstContact

## Problems (verified by review)

- Manifest/layout: strict `assertHostManifest`/`assertHostLayoutSnapshot` (`host-server/owner.ts:183-249`) plus loose `isManifest`/`isSnapshot` (`manifest.ts:85-94`, `layout.ts:40-50`). Files re-read and re-parsed on every `projects()`/`layout()` (`server.ts:257-258`), every hello's `hostName` (`server.ts:296`), both files per new agent (`server.ts:173-178`), old layout on each sync (`owner.ts:392`).
- `owner.ts:342-358` `writeJsonAtomic` copies `lib/fs-atomic.ts` `writeFileAtomic` (already used by `hook-cursor.ts:21`). `owner.ts` hand-writes `isRecord`, boolean (127-129) and string-array (131-138) checks; `electron/ipc-validate.ts` has `assertBoolean`/`assertStringArray`.
- `hostLayoutSnapshot` (`owner.ts:260-283`) is desktop-side; `backend/host-server-sync.ts:39` imports it from host-server.
- Handlers take `manifest: unknown`; should declare `HostManifest`/`HostLayoutSnapshot` after validation.
- `server.ts:166-168` `let bridge | chatMirror | relay = null`; `chatMirror` assigned 20 lines later, used as `chatMirror?.`. `hostRelay()` throws-if-unbuilt accessor (220-223); `builtRelay` (300-308) second name. `deps.remoteControl`/`deps.hostServer` (261-281) rewrap each method; `handlers.ts` (343-401) wraps again — three identity hops (e.g. `hostServerSyncManifest` → `deps.hostServer.syncManifest` → `ownerSync.syncManifest`). Root cause: only `RelayGate` needs `frames`.
- `server.ts:352-366` `ensureFeed` makes an extra `replayHooks(0,{headOnly:true})` call, pre-seeds cursor `{seq:0}` to defeat `HostHookFeed`'s skip-history-on-first-contact (`backend/hook-feed.ts:212-218`), so `feed` is lazy and `feed?.` ×4.
- `start()` awaits `relay.init()` before connecting the daemon (`server.ts:451-458`) though independent.
- `HostServer` exposes `agents`, `secretBox`, `whenCaughtUp` only for tests.
- `serve.ts:52-70` (`readPid`, `isOtherLiveProcess`) repeats `lifecycle.ts:54-82`.
- `started-while-away.ts` builds a fresh one-tab panel twice (113-124, 142-151).

## Do

1. `OwnerSnapshotStore` (in `owner.ts` or new `host-server/owner-snapshot.ts`): loads manifest + layout once at boot through the strict validators (invalid → empty, logged), holds them in memory, replaces on sync, writes with `writeFileAtomicAsync`/`writeFileAtomic` from `lib/fs-atomic.ts`. All readers use it. Delete `isManifest`, `isSnapshot`, `writeJsonAtomic`, and owner's hand-written checks in favour of `ipc-validate.ts` helpers.
2. Move `hostLayoutSnapshot` to `electron/backend/host-server-sync.ts`.
3. Owner handlers typed with `HostManifest` / `HostLayoutSnapshot` after assert.
4. `createHostServer`: build without nullables. Relay (stores, push, connector) is built eagerly and receives `frames` at `start(frames)` (or getter). `relay`, `relay.remoteControl`, `ownerSync` go straight into deps; host table calls them without wrapper hops. `chatMirror` built before it's referenced.
5. `HostHookFeedOptions.firstContact: "head" | "replayAll"` in `backend/hook-feed.ts` (default preserves desktop behaviour). Host builds the feed eagerly with `"replayAll"`; delete `ensureFeed` and the `feed?.`s.
6. Startup: run `relay.init()` and daemon connect in parallel (`Promise.all`) where independent.
7. Trim `HostServer` public interface; tests reach internals via a test-only factory option or the harness instead.
8. Shared pid-file helper (e.g. `host-server/pid-file.ts`) used by `serve.ts` and `lifecycle.ts`. If `terminal-host/transport-local.ts:143-260` can reuse it cleanly, do so; otherwise leave it.
9. `started-while-away.ts`: one `singleTabPanel(...)` helper.

## Files to touch
- `electron/host-server/owner.ts`, `manifest.ts`, `layout.ts`, `server.ts`, `handlers.ts`, `serve.ts`, `lifecycle.ts`, `started-while-away.ts`, `relay.ts`, `index.ts`, new `owner-snapshot.ts` / `pid-file.ts`
- `electron/backend/hook-feed.ts`, `electron/backend/host-server-sync.ts`
- `electron/host-server/__tests__/*`

## Added from ticket 2

10. Fix the eslint `no-useless-assignment` error in `electron/host-server/lifecycle.ts` (~174).
