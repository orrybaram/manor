---
title: Split BackendRegistry around a per-host HostConnection
status: done
priority: high
assignee: opus
blocked_by: [4]
---

# Split BackendRegistry around a per-host HostConnection

Read `index.md`. `electron/backend/registry.ts` has about 1000 lines doing
five jobs.

1. **`host-connection.ts`**: a `HostConnection` class per registered host.
   - It owns status, the `attempt`/`resumeToken`/`autoConnect` counters, the
     provider and backend, `warnings` (kept separately from the state instead
     of copied into four `setState` calls), and a `disposed` flag.
   - It holds the connect, disconnect, reconnect and state-machine logic that
     currently sits in the registry.
   - `disposed` replaces the 11 `this.hosts.get(entry.hostId) === entry` checks.
2. **`host-view.ts`**: the gates, the Proxy view and `unavailableBackend`.
   Use the shared `streamAfter` from item 5 for the deferred push/clone streams.
3. **`session-owners.ts`**: a `SessionOwners` class with `claim(id, hostId)`,
   `release(id)` and `ownerOf(id)`.
   - It has one explicit rule, replacing the six scattered writes to
     `sessionHosts` that follow two conflicting rules.
   - Move the stream-event dedupe from `dispatchStreamEvent` into it.
   - Update `RoutedBackend` (`noteSession`) and `ipc/*` callers to use it.
4. **`emitter.ts`**: a small typed `Emitter<T>` with `on() → unsubscribe` and a
   try/catch `emit`. It replaces the four copy-pasted listener fan-outs in the
   registry and `RemoteBackend.emitHostEvent`.
5. **`streamAfter`** in `electron/backend/exec.ts`:
   `streamAfter(pre: Promise<T>, start: (t) => { cancel }, onDone)`. It is the
   single "synchronous cancel handle over an async precondition" helper.
   `local-git.ts` `pushStream` uses it too.
6. **Pass the version once.** The registry takes required `localVersion` and
   `remoteVersion` in its constructor and stores the version on each
   connection. Delete `setVersion`, `hostVersion()`, the connect-time
   `LOCAL_HOST_ID ? …` branch, and `RoutedBackend.connect`'s `opts.version`.
   Update `app-lifecycle.ts`.
7. **Tighter types.** Type the remote factory as returning a
   `RemoteHostBackend extends WorkspaceBackend` with required `retryNow`,
   `onHostEvent` and `pty.replayHooks`. Drop the optional members on
   `WorkspaceBackend`/`PtyBackend` and the no-op `onHostEvent` in
   `LocalBackend`. Build the hook feed and gates at registration, which removes
   the local/remote branches in `add` and `makeView`.
8. **Narrow `replayHooks`.** Ticket 3 made `client.replayHooks()` always return a `HookReplay`. Narrow `PtyBackend.replayHooks` / `ReplaySource` / `LocalPtyBackend.replayHooks` from `HookReplay | null` to `HookReplay`, and delete the `result === null` branch in `hook-feed.ts` and its test.
9. **Merge git progress streams.** In `local-git.ts`, `startPush` and
   `cloneStream` duplicate the stderr line buffering and `onExit` handling.
   Merge them into one private `gitProgressStream(args, splitRe, cb)`.

`registry.ts` must end up around 300 lines or fewer, with every new file under
500. Run `pnpm build` and the `electron/backend` tests.

## Files to touch
- `electron/backend/registry.ts`
- `electron/backend/host-connection.ts`, `host-view.ts`, `session-owners.ts`, `emitter.ts` (new)
- `electron/backend/exec.ts`, `local-git.ts`, `routed-backend.ts`, `remote-backend.ts`, `local-backend.ts`, `types.ts`
- `electron/app-lifecycle.ts`, `electron/ipc/pty.ts`, `electron/ipc/agents.ts`, `electron/ipc/ports.ts` (the session-owner callers)
- related tests
