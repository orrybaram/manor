---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-226: Host server review fixes

## Context

ADR-225 (a Manor server on every host) landed on `feat/adr-218-host-server`
as 23 commits, 141 files, +12.8k lines. A strict code-quality review of that
branch (five area reviewers: bridge core, `electron/host-server/`, the
desktop owner channel, platform ports and secrets, renderer and E2E) found
five correctness blockers and a set of structural problems. The common thread
is that the host server was built by copying desktop code rather than
extracting it, and that a few concepts were patched at many call sites rather
than modelled once.

### Blockers

- **B1. Sealed secret files are torn on quit.** `platform/sealed-file.ts`
  `writeSealed` writes the target file in place (no temp + rename), and
  `app-lifecycle.ts` `before-quit` does `void Promise.all([...flush()])`. The
  pre-branch stores used sync `writeFileSync`. A torn identity file regenerates
  the relay identity on next start: new room, every phone unpaired.
- **B2. `SealedWriter` swallows write failures.** `flush()` never rejects, so
  `pair()` and `revoke()` report success when nothing was saved. A failed
  revoke resurrects the device after restart.
- **B3. A SecretBox hiccup reads as a missing file.** A systemd-creds spawn
  failure or timeout makes `readSealed` throw, and every store responds by
  starting fresh (new identity, empty devices, new VAPID key).
- **B4. The phone learns it is on a host server by failing a call.**
  `src/bridge/client.ts:167` sets the restricted flag on the first
  `unavailable:host` reply. The first New Workspace attempt still errors (D5
  says it never should), and entry points are gated by hand, missing
  `App.tsx` `openNewWorkspace` and the `new-workspace` / `new-agent` commands.
  The hello already carries `hostName`.
- **B5. Every daemon connection awaits the host server.**
  `terminal-host/bridge.ts` runs `await ensureServer()` before the daemon
  hello, putting a lock, spawn and socket wait on every connect.
  `server-bridge` already ensures the server.

### Structural findings

- **S1.** The agent pipeline (coalescing hook sink, driver wiring,
  `resyncPaneFacts`) exists three times: `app-lifecycle.ts`,
  `host-server/agents.ts`, and `two-readers.test.ts` — so the ADR-225 guard
  test compares a copy, not the real wiring. The agent read handlers and
  reconcile-stale are copied into `host-server/handlers.ts` / `server.ts`
  because `bridge/handlers/agents.ts` imports Electron. The relay room logic
  in `host-server/relay.ts` copies `RemoteControlController` and drops its
  serialisation.
- **S2.** "Another daemon client holds this pane" is spread over five places
  (`heldElsewhere`, `refreshWinsizeOwner`, `createShaped(forceFollower)`, two
  host wrapper handlers, a hard-coded `1` in `winsize.ts`) instead of living in
  `pty-attachments.ts`, the winsize-owner registry.
- **S3.** The owner-channel lifecycle lives in `backend/registry.ts` (two
  maps, a shadow status map, a late-bound cyclic `setHostServerSync`) when
  `RemoteHostConnection` already owns a per-host object with that exact
  lifecycle (`hookFeed`).
- **S4.** `HostServerClient` hand-rolls an untyped bridge client, with a dead
  `subscribe` path; `openServerBridge` copies `openBridge`.
- **S5.** Host manifest/layout: two validators per shape, disk re-reads on
  every call, a copied atomic writer, and the desktop's `hostLayoutSnapshot`
  living in `host-server/`.
- **S6.** `devices.ts`, `relay/identity.ts` and `push.ts` each re-implement a
  sealed JSON store.

Plus lower-priority items: the `server.ts`/`server-core.ts` split is a file
move rather than a seam; two broadcast paths; dead `Notifier` / `AppInfo`
ports; nullable construction in `host-server/server.ts`; a hook-feed
workaround (`ensureFeed`); five writers of the `HostPushEndpoints` cache with a
connect race; an overlapping PR cache in `github.ts`; two shapes for one
pairing credential; side effects in `listPairings()`; `HostPhoneAccess`
double-fetch race; test and E2E helper duplication.

## Decision

Fix every finding on `feat/adr-218-host-server`, behaviour-preserving except
where the current behaviour is the bug. Organised as twelve sequential
tickets (most share files, so none run in parallel):

1. **`SealedStore<T>`** (`electron/platform/sealed-store.ts`) replaces
   `SealedWriter` and the three bespoke stores' load/persist plumbing. Writes
   go through a new async `writeFileAtomicAsync` in `electron/lib/fs-atomic.ts`.
   `flush()` rejects with the first failure; `readSealed` returns `null` only
   on ENOENT; the box throws `SecretBoxUnavailableError` when its helper could
   not run, and stores do not reset on it. `before-quit` waits for flushes.
   `SecretBox` contract tidied; a plaintext host upgrades itself to a stronger
   backend when one appears.
2. **Dead ports and controller wiring.** Delete `platform/notifier.ts` and its
   knip ignore; replace `AppInfo` with an `appVersion: string`; the controller
   takes `hostPushEndpoints` as a constructor function (no nullable setter, no
   `"local"` string).
3. **One generic `BridgeServer<D>`.** Fold `server-core.ts` back into
   `server.ts`; a `toHandlerTable(METHODS)` helper in `method.ts` builds both
   the desktop `DESKTOP_TABLE` and the host table without casts at call sites.
   `HandlerTable` carries `unavailable` and `localOnlyCallers`. One injected
   event source, one public `publish`. The authenticator returns a caller
   identity. `sessionGrid` and `BridgeServerDeps` move out of the handler and
   IPC layers.
4. **Foreign winsize hold in `pty-attachments.ts`.** `setForeign(paneId, on)`
   makes `ownerOf` return a foreign viewer; the five patches go away and the
   host table reuses the desktop pty handlers.
5. **Shared agent pipeline and Electron-free agent handlers.**
   `createAgentPipeline(...)` used by `initApp`, `createHostAgents` and the
   two-readers test; agent read handlers and `agentsReconcileStale` move into
   an Electron-free module over an `AgentReadDeps` slice.
6. **Host composition.** In-memory `OwnerSnapshotStore` (strict validation at
   boot, atomic writes); `hostLayoutSnapshot` moves to
   `backend/host-server-sync.ts`; `createHostServer` builds without nullables;
   `HostHookFeed` gets a `firstContact` option replacing `ensureFeed`;
   independent startup runs in parallel; shared pid-file helper.
7. **`RelayRoom`** (`electron/remote-control/relay-room.ts`): pair, revoke,
   revokeAll, reset, revokeStale, run one at a time; used by both the desktop
   controller and the host relay.
8. **Owner channel on `RemoteHostConnection`.** `serverClient` becomes a field
   with the `hookFeed` lifecycle; registry plumbing deleted.
   `HostServerClient` loses `subscribe`, gets a type derived from the host
   `METHODS`; `spawnBridgeChild` / `awaitHelloLine` shared in
   `transport-ssh.ts`. `remote-bridge` stops awaiting `ensureServer`.
9. **Desktop sync tidy.** `HostServerSync` owns the `HostPushEndpoints`
   cache and refreshes after VAPID keys in order; `github.ts` drops
   `settledPrs` / `prSummary`; `manifestRecords` returns `ManifestProject[]`;
   `LastKnownWorkspaces.recall` reuses `latest`.
10. **Phone knows its host from the hello.** A `src/bridge/connection.ts`
    holds hello facts (active room, host name, is-host-server); gating moves
    into `NewWorkspaceDialog` and command availability; one pairing credential
    shape; `listPairings()` is a pure read.
11. **`HostPhoneAccess` on a store slice**, one `hosts.serverStatus` call
    returning devices, a dedicated `hosts.pairingChanged` event, reset confirm
    reusing `ResetRelayDialog`; phone menu CSS shared.
12. **Tests.** Split `host-server.test.ts` along its describe blocks with a
    shared harness that drives the real `HostServerClient`; de-duplicate E2E
    pairing and clean-slate helpers.

## Consequences

**Better**
- Pairings survive quits, crashes and flaky secret helpers; a revoke that did
  not persist is reported, not silently undone.
- The phone never sees an error for a refused host-server action.
- Remote connect latency no longer includes host-server startup.
- One agent pipeline, one set of agent handlers, one relay room, one winsize
  registry, one sealed store: the desktop and host server can't drift on these.
  The two-readers test checks real code.
- Roughly 600–800 lines deleted net; several nullable states and two cyclic
  late bindings gone.

**Harder**
- A large, cross-cutting refactor on an unmerged feature branch. Every ticket
  touches shared modules, so they run strictly in sequence.
- `RelayRoom` and `createAgentPipeline` are new shared abstractions that both
  compositions now depend on; a change to either affects desktop and host.

**Risks**
- Behaviour regressions in the relay/pairing path. Mitigated by existing unit
  tests (`host-server.test.ts`, `controller.test.ts`, `devices.test.ts`) and the
  `host-server.spec.ts` E2E, run at the end.
- Async sealed writes awaited at quit add a short delay on quit with
  systemd-creds; bounded by the helper's existing timeout.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
