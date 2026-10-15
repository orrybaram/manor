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

# ADR-230: Host server hardening

All four host-server slices are on main:
- ADR-225 and ADR-226: a host server on every remote host.
- ADR-227: that server owns its host's state.
- ADR-228: one renderer talks to every server.
- ADR-229: hosts Manor starts itself.

Each slice recorded its gaps under "Known limits as built". This ADR fixes the
routing and lifecycle gaps among them. It adds no features.

## Context

Every gap below was checked against the code at `b128a6fa` before this ADR
was written. Paths are as of that commit.

### Lifecycle (ADR-229)

- **L1. Idle stop ignores phones.**
  - The host reports `desktopViewing` from
    `bridge.hasDesktopViewerSubscriber("pty", "output")`
    (`electron/host-server/server.ts:367`, `electron/bridge/server.ts:469`).
    That counts only connections whose hello said `viewer: "desktop"`.
  - A phone paired with the host is a `device` connection. A phone or an old
    window forwarded by the desktop arrives on the `owner` channel. Neither
    counts.
  - So `HostIdleStop.check` (`electron/backend/host-idle-stop.ts:120`) can
    stop a box that a phone is watching.
- **L2. A reconnect never re-runs `up`.**
  - `RemoteHostConnection.bringUp` runs `provider.ensureUp` only on a
    connect (`electron/backend/host-connection.ts:694-707`).
  - `beforeReconnect` (`:610`) checks only for `sleeping` or `missing`.
  - A recipe box that comes back at a new address is redialled at the old
    one forever, until the next full connect or wake.
  - ssh and command providers have a no-op `ensureUp`, so this only matters
    for recipes.
- **L3. Launch restore wakes a sleeping host.**
  - Mounting a restored pane calls `pty.create`. Three paths then wake the
    host:
    - the renderer router's `sleepingTarget` (`src/bridge/router.ts:580`);
    - `HostRouting.wakeIfAsleep` (`electron/server/host-routing.ts:470`);
    - the backend gate in `electron/backend/host-view.ts:65-71`. On
      `disconnected` or `connecting` it calls `conn.ensureConnected()`, a
      connect that wakes.
  - The asleep banner, with its "wake it" option, already exists
    (`HostOfflineBanner`, `HostIndicator`). So does the remount once the
    host is back (`useRemoteRecovery`). The user never sees either at
    launch.
- **L4. port-pipe drops half-closed connections.**
  - On the box, `runPortPipe` reuses the bridge's `pump`, which resolves on
    the first direction to finish. `teardown` then destroys the socket
    (`electron/terminal-host/port-pipe.ts:84`,
    `electron/terminal-host/bridge.ts:115-180`).
  - On the desktop, `CommandHostProvider`'s local server and the box's
    `net.createConnection` both use the default `allowHalfOpen: false`
    (`electron/backend/providers/command-provider.ts:170`).
  - So a client that shuts its write side after sending a request never gets
    the reply.

### Routing (ADR-228)

- **R1. A drop with an unlisted close code keeps its reachability.**
  - The relay pipe calls only 4404, 4410, 4429 and 4504 unreachable
    (`src/bridge/transports/relay-pipe.ts:103`).
  - After a 1006, `WsTransport.onClose` (`src/bridge/transports/ws.ts:483`)
    redials with backoff while the source stays `connected`.
  - So calls queue behind the backoff, merged reads wait on the dead server,
    and pane listeners stay bound to it.
  - A test pins this: `relay-pipe.test.ts:541`, "does not call an ordinary
    drop unreachable".
- **R2. Branch and diff watching go home only.**
  - `branches.*` and `diffs.*` have no route (`electron/bridge/routes.ts`),
    so the phone's router sends them home.
  - Home drops workspaces of hosts it doesn't know.
  - Host servers have no branch or diff watcher at all
    (`electron/host-server/handlers.ts`).
  - `callHome` stamps records but doesn't re-key the
    `Record<WorkspaceKey, …>` that these events carry. So even home's own
    updates may miss the phone store, whose keys include the host.
- **R3. The selected project is home's index.**
  - `projects.getSelectedIndex` and `select` route `"home"`
    (`routes.ts:139-140`), but the phone shows the merged list
    (`mergeProjects`, `router.ts:835`). The two indexes drift.
- **R4. Stale Linear status on an open phone.**
  - `src/bridge/linear-servers.ts` re-asks `isConnected` only on hello and
    home's `hosts.pairingChanged`.
  - Nothing publishes when a token is saved or cleared (`electron/linear.ts:95-111`).
- **R5. Claims on remote tabs aren't dropped.**
  - `dropClaimsOnGoneTabs` (`electron/layout/layout-store.ts:888`) runs only
    in `applyNow`, which only runs for entries the store holds.
  - Remote layouts arrive through `HostProxy.onLayoutChanged` and
    `publishLayoutDiff` (`electron/backend/host-proxy.ts:592-693`), which
    never drop a claim. The claim lasts until the window closes.
- **R6. Main's forwarded callers share one host viewer.**
  - `HostRouting.invokePty` sends every routed `pty` call through main's one
    owner channel and drops the caller (`host-routing.ts:323-342`).
  - So every phone on the desktop and every window that fell back gets the
    same `winsizeOwner`. All of them pass the host's resize gate, and the
    last to fit wins.
  - Found while checking this: one caller's `detach` releases the shared
    viewer for all of them.
- **R7. A reset during `linkHostPairings`.** `linkOne`
  (`electron/remote-control/host-links.ts:140-183`) runs `status`, then
  `pair`, then `setHostLink`. The reset
  (`hosts.resetPairingKeys` → `RelayRoom.reset`) doesn't go through the
  links queue. That leaves two windows:
  - **(a)** The reset lands after `pair`. The desktop records a link to a
    device the reset has already revoked, and the phone gets dead room
    credentials.
  - **(b)** The owner channel drops after the host commits `pair` but before
    the answer arrives. `link()` only logs, so the device stays on the host,
    linked to nothing, and is never revoked.
- **R8. "This machine" on the phone.**
  - `memberHostName` and `hostLabel` (`src/lib/hosts.ts:60,70`) say "This
    machine" or "this machine" for `local`. On a phone, `local` is the
    desktop.
  - These sites call them directly instead of
    `serverHostName(id) ?? memberHostName(id, hosts)`:
    - `src/store/auto-join.ts:40`;
    - `src/store/project-store.ts:946,1021,1077`;
    - `ProjectItem.tsx:176,518`;
    - `ProjectSetUpOnSection.tsx:48`;
    - `ProjectSettingsPage.tsx:632`;
    - `CloneToHostDialog.tsx:131`;
    - `NewWorkspaceDialog.tsx:289`;
    - `TasksView.tsx:139`.
- **R9. Issue #269: the git route and the git backend pick a host
  separately.**
  - `electron/routes/git.ts` `resolveProjectByPath` has a fallback across
    hosts.
  - `RoutedBackend.git` routes by `PathRouter.hostIdForPath`
    (`electron/backend/routed-backend.ts:129,181-205`).
  - In the issue's scenario, git runs on `box` and diffs against
    `local-p`'s default branch.
  - The test at `electron/routes/git.test.ts:267` can't see this, because
    its deps hold one fake `git`.

### Smaller items (cheap, so included)

- **S1. Stats-only reads ignore remote agents.**
  - The busy-agent gauge reads only the desktop's own agents
    (`create-manor-server.ts:572`), and so does the kill-counter lookup
    (`processes.ts:37`, `process-control.ts:172`).
  - Remote agents are already on the desktop through `HostRouting.agents()`.
- **S2. Dead `callerHostId` / `callerMaySee` branches.**
  - Nothing in production sets `callerHostId` any more (ADR-227 D8).
  - About 70 production lines and 200 test lines go.
  - The catch: `electron/routes/context.ts:101` uses `callerMaySee` as a
    live exact-host filter.

## Decision

One ticket per gap, with three exceptions:
- the two ADR-228 known limits that share `host-routing.ts` (R6 and its
  detach bug) are one ticket;
- the docs and E2E are one ticket at the end;
- **every behavior fix lands with a regression test that fails on the base
  commit.**

### D1. Idle stop counts every viewer, not only desktop windows (L1)

- `BridgeServer.viewing(ns, event)` returns
  `{desktop, device, forwarded}`:
  - `desktop`: a `viewer: "desktop"` connection subscribed;
  - `device`: a `device` connection subscribed;
  - `forwarded`: an `owner` connection subscribed whose hello did not say
    `viewer: "desktop"`.

  `HostProxy` subscribes the owner channel to `pty.*` only in `watchPty`, so
  an owner `pty.output` subscription means a forwarded viewer. A desktop
  window's own viewer stream (ADR-228 D4) is an owner connection too; it
  counts as `desktop` only, never as `forwarded`.
- A pane is watched if any connection has `pty.output`. A phone that has an
  agent's chat open also counts: `device` subscriptions to `chat.entry` and
  `chat.taskEntry`. Those are the phone's main view of an agent.
- `HostServerStatus` gains `viewing: {desktop, device, forwarded}`.
  `desktopViewing` stays for older desktops.
- `HostIdleStop.check` re-arms when any field is true. An older host has no
  `viewing` field, so the check falls back to `desktopViewing` alone.
- A phone left open on a terminal keeps the box up. That is intended: idle
  stop exists to save money on hosts nobody uses, and that host is in use.

### D2. A recipe host re-runs `up` once per drop (L2)

- `ReconnectSupervisor`'s `beforeAttempt` receives the attempt number,
  threaded through `beforeReconnect` in `remote-backend.ts` and
  `registry.ts`.
- `RemoteHostConnection.beforeReconnect(attempt)` decides whether to re-run
  `up`, for a recipe provider only. It does so once per drop, before the
  third attempt (attempt index 2), when all of these hold:
  - the host is not sleeping or missing (the checks it runs today);
  - the recipe has a `status` command, or does not declare
    `capabilities.autoSleep`. Otherwise a box that put itself to sleep would
    be woken, which ADR-229 D1 forbids.
- The flag resets on `hostReconnected`.
- `RecipeHostProvider.ensureUp` gets an in-flight dedupe (one shared
  promise), as `statusRun` already has. A wake, a connect and a re-up can
  then never run `up` twice.
- Errors from `up` are logged and the redial carries on. A failing `up`
  during a reconnect does not make the host `hostFailed`.
- `up`'s progress lines show while `reconnecting` too, not only while
  `connecting`.
- `bind()` swaps the inner transport only when `up` returns a different
  connection, as today. The old inner transport is disposed only after the
  client's streams to it have closed. That is the case during a redial,
  because the drop closed them.
- **As built:**
  - The provider gains an optional `refresh(onProgress)`, which only
    `RecipeHostProvider` has. The `autoSleep` check lives there: `refresh`
    declines (returns false) for a recipe with no `status` whose last `up`
    said `autoSleep`.
  - A declined refresh still counts as this drop's re-run, so it isn't
    asked again before the host comes back or drops anew.
  - Progress lines go to the caller that started `up`. A caller that joins
    an `ensureUp` already in flight gets the shared promise, not its
    progress lines.
  - **Found by the E2E (ticket 16):** an exec way in whose target is gone
    (`docker exec` on a renamed container) fails as a bootstrap error,
    which the reconnect loop treats as permanent. That stopped the loop at
    attempt 0, before the re-run of `up` could find the new target. Now a
    host whose provider has `refresh` keeps such failures retrying until
    this drop's re-run has had its turn
    (`RemoteHostConnection.retryPermanentFailure`, passed to `RemoteBackend`
    as `retryPermanentFailure`). After that they stop the loop as before.
    ssh failures exit 255 and were always retried.

### D3. Launch restore waits for real intent (L3)

- **A restored pane does not wake its host.** "Restored" means it was
  mounted from the persisted layout in the first mount after launch, and
  belongs to the workspace the window shows at launch. Opening another
  workspace afterwards is intent: its panes wake the host as before. (This
  narrowing was decided during implementation, ticket 3.)
- Waking stays as it is for anything the user starts: a new pane or tab,
  typing in a mounted pane, "wake it", or launching an agent.
- **How:**
  - `pty.create` and `pty.attach` take an optional `wake: false` in their
    options. Three places honour it:
    - the renderer router's `sleepingTarget`;
    - `HostRouting.invoke`'s `wakeIfAsleep`;
    - the backend gate in `host-view.ts`. With `wake: false`, `disconnected`
      or `connecting` runs a non-waking connect
      (`conn.connectNoWake()` = `startConnect(false)`). If that leaves the
      host `sleeping`, it throws `HostUnavailableError(hostId, "sleeping")`.
  - The renderer collects the pane ids of the visible workspace's
    persisted layout at startup, in the app store.
    `useTerminalConnection.create` passes `wake: false` for an id in that
    set. The id is forgotten once its first create has settled, not when
    it is sent, so a StrictMode double mount doesn't wake the host either.
  - A resync's `attach()` never sends `wake: false`.
  - The reply is `host-unavailable`, so the pane waits behind the existing
    asleep banner. The renderer router and `HostRouting` answer
    `{ok: false, reason: "host-unavailable"}` rather than throwing, so the
    pane reaches `awaitHost`. "Wake it" or the host coming up from
    elsewhere remounts it through `useRemoteRecovery`. Nothing new is
    needed there.
- A host that is merely `disconnected` and not asleep still connects
  without waking, as a background connect does today.
- Agent resume commands queued for restored panes wait for the wake. That
  is the point.

### D4. port-pipe carries half-close in both directions (L4)

- **Box.** `runPortPipe` gets its own pump instead of the shared bridge
  `pump`. The bridge's stdin EOF really means "gone", so the shared pump
  keeps that meaning. The new pump:
  - connects with `net.createConnection({ …, allowHalfOpen: true })`;
  - pipes each way with `end: true`;
  - resolves only when both directions have ended;
  - destroys on an error from either side.
- **Desktop.** `CommandHostProvider` listens with
  `net.createServer({ allowHalfOpen: true }, …)`. Its existing pipes already
  forward `end`.
- **Linger.** Once one direction has ended, the other gets 5 min of
  silence before the pipe closes. A peer that never closes then can't leak
  a pipe.
- ssh forwards (`ssh -L`) are not affected.

### D5. A non-clean drop becomes unreachable after a grace period (R1)

- `WsTransport.onClose` keeps reporting the listed codes at once.
- For any other code that leads to a redial, it starts a 4 s grace timer.
  If no hello arrives before it fires, it calls `onStatus("unreachable")`.
  This copies the pattern of `FIRST_HELLO_DEADLINE_MS` in `install-web.ts`.
- `onReady`, `close()` and the 4401 and key-mismatch stops clear the timer.
- With the grace period, a 1 s blip doesn't flash the phone's reachability
  overlay or bounce pane listeners home and back.
- Within 4 s a drop moves calls to a desktop that lists the host, or fails
  them fast with `unavailable:host-away`.
- The test "does not call an ordinary drop unreachable" becomes "calls an
  ordinary drop unreachable after the grace period, and not before".
- No new `Reachability` value. Adding "reconnecting" would touch six
  switch sites for no behavior a user can tell apart.

### D6. Branches and diffs are watched on the server that owns the workspace (R2)

- **Host servers get watchers.**
  - `createManorServer` builds `BranchWatcher` and `DiffWatcher` on both
    platforms.
  - The diff watcher's `mainWindow` gate becomes a platform option.
  - `branches` and `diffs` join the host's handler allowlist.
- **Watched sets are per connection.** `BranchWatcher.start` and
  `DiffWatcher.start` keep one set per caller connection and watch the
  union. Until now, a phone's `start` replaced the desktop window's set on
  the same server. A connection's set goes on `stop` or on disconnect.
- **A `"split"` route kind**, for `branches.start/stop` and
  `diffs.start/stop`:
  - The router sends each server only the workspaces it answers for:
    `onlyKnownHosts` filtered by `answersFor`, then `toServerArgs`.
  - Servers that are away are skipped. They get their share when they come
    back, through the existing replay on join.
  - The routes surface test lists the new kind.
- **Events fan out and are re-keyed.** `branches.*` and `diffs.*` join the
  fan-out namespaces. In `stampEvent`, each `Record<WorkspaceKey, …>` is
  re-keyed with `stampKey`, and keys the entry doesn't answer for are
  dropped. This also fixes home's own updates on the phone, which arrive
  under server-form keys today.
- **Desktop windows don't change.** The desktop's own watchers already poll
  remote workspaces through each host's backend
  (`BranchWatcher.scanRemote`, `electron/branch-watcher.ts:116`), and a
  desktop window in pass-through keeps calling home.
- **Older host servers.** The split only matters on the phone, and on a
  window with direct host bridges. When a host server is too old for the
  calls (`unavailable:host`), the router gives that server's workspaces to
  a desktop that lists the host, which watches them as today.
- **As built:**
  - The router merges `branches.changed` and `diffs.*` payloads across
    servers and delivers the union, trimmed per server to what it answers
    for. The consumers treat each payload as the whole picture, so one
    server's event must not wipe another's entries.
  - `BranchWatcher` re-emits when a connection's own list changes, even for
    workspaces already watched for someone else.
  - Only `start` and `stop` reach host servers. The phone's diff-pane reads
    (`diffs.getFullDiff`, `getLocalDiff`, `getStagedFiles`) still go home.
  - A server marked `refused` (too old) is cleared only on a resync or a
    bridge change.
  - The watchers moved into `SharedDeps`. The per-connection sets live in
    `electron/watched-sets.ts`.
  - A `start` whose connection has already dropped leaves no stale set
    (ticket 17).

### D7. The selected project is translated in the router (R3)

The router translates the index. There is no new server method.
- When it isn't in pass-through, `merged()` for `projects.getAll` records
  home's raw id order and the merged id order.
- `getSelectedIndex` maps home's index to an id, then to a merged index,
  clamped.
- `select(i)` maps the merged index to an id, then to home's index.
- A project home doesn't hold is selected on the page only. The selection
  isn't persisted across a reload; that is noted as a known limit.

### D8. Linear publishes its connection state (R4)

- `LinearManager` takes an `onChange(connected)` callback, called from
  `saveToken` and `clearToken`. `linearConnect` validates the key first
  (`getViewer(apiKey)`) and saves only after that, so a failed connect
  emits nothing.
- `createManorServer` wires `onChange` to
  `bus.publish("linear", "connectionChanged", connected)`, on both
  platforms.
- `EventMap` gains `linear.connectionChanged`, and `SUBSCRIPTIONS` gains
  `linear.onConnectionChanged`.
- `linear-servers.ts` subscribes on each entry's bridge as entries join and
  leave, as `openFan` does, and updates that entry's `connected`.
- The hello and pairing refresh stay, for older servers.
- The desktop's Linear settings sections subscribe to the same event.

### D9. Remote layouts drop claims on tabs that leave (R5)

- `LayoutStore.dropForeignClaims(key, before, after | null)` reuses the
  tab-difference rule of `dropClaimsOnGoneTabs`:
  - `null` means the workspace was removed, so all its claims go;
  - with no `before`, nothing is dropped. That keeps the "tab doesn't
    exist yet" rule.

  It doesn't broadcast, because the layout publish carries the claims.
- `HostProxyOptions.onLayoutMoved(key, before, after)` is called in
  `onLayoutChanged` and in `publishLayoutDiff`, before the publish, so a
  window that lost its claim sees that in the same layout.
  `create-manor-server.ts` wires it to the store.

### D10. Main arbitrates its forwarded callers' winsize (R6)

Main decides among its own callers before forwarding. There is no protocol
change, so older hosts keep working.
- `HostRouting.invokePty` builds a `Viewer` from `ctx.caller` and keeps it
  in main's process `PtyAttachments` registry. Pane ids are unique across
  hosts.
- **create, attach, reset:** a caller that wouldn't own the pane locally is
  sent the host's current grid instead of its own. The `winsizeOwner` in
  the answer is `hostOwner && localOwner`.
- **resize:** dropped unless that caller owns the pane locally.
- **claimWinsize:** claimed locally, then forwarded.
- **write:** runs `reclaimOnInput` locally.
- **detach:** releases the caller locally. It is forwarded to the host only
  when no local caller is left, which fixes the detach-drops-everyone bug.
- **`winsizeOwner` events** for a remote pane are delivered per connection,
  through a new `BridgeServer.publishTo(connectionId, …)`. That replaces
  the keyed fanout, which sent every subscriber the same flag.
- Disconnect cleanup (`releaseViewer`) already runs over the same registry,
  and now covers remote panes too.
- **A known residue:** a phone paired with the host directly still competes
  with main as a whole. The host decides between them as today.
- **As built:**
  - The host's current grid is cached in `HostRouting` (`ptyGrids`).
  - `PtyAttachments` is now a class. `processAttachments` is the process's
    instance, which main's local panes and its forwarded callers share.
  - Forwarded `create`, `attach` and `reset` answers always carry
    `winsizeOwner`.
  - Only main's local holders of a pane get per-connection owner flags.
  - A follower that creates before any grid is cached sends its own size.

### D11. Linking and resetting a host are serialized, and a mint is checked (R7)

- **Serialize.** `hostsResetPairingKeys` runs through a new
  `HostPairingLinks.resetHost(hostId)` on the same queue as `link`. After
  the reset it calls `devices.dropHostLinks(hostId)` and clears that host's
  pending revokes, because the reset already revoked every host device.
  That closes window (a) for resets made from this desktop.
- **Check the room.** After `pair`, `linkOne` compares the pairing URL's
  room id with the one `status` returned before the mint. If they differ,
  the host was reset by something else (the box's CLI or another desktop).
  The minted device is queued as a pending revoke and no link is recorded.
  Returning null lets the next hello mint again.
- **Window (b): an answer lost after the host committed.**
  - Before `pair`, the desktop records a pending mint
    `{label, startedAt}` in the persisted host, next to `pendingRevokes`.
  - On the next owner connect, `HostServerSync` lists the host's devices and
    revokes any device that matches all of these:
    - it has that label;
    - it was created at or after `startedAt`;
    - no desktop link points to it.

    Then it clears the pending mint.
  - Mint labels carry a random suffix, so a pairing the user made directly
    on the host can't match.
  - If `listDevices` doesn't return a creation time, the ticket adds one.
    That is an additive field, and older hosts are treated as matching on
    label alone.
- **As built:**
  - `pendingMints` is a list per host, not one slot.
  - A mint still in flight is never reconciled; only one whose answer was
    lost is.
  - The `createdAt` match allows 10 min of clock skew between the desktop
    and the box (`MINT_CLOCK_SKEW_MS`).
  - Linked pairings show their 6-hex suffix in the host's device list, for
    example "Orry's phone (a1b2c3)".
  - A reset made from elsewhere is caught by the room check. A link that
    points at the old room is replaced only on the phone's next hello.

### D12. The phone names the desktop (R8)

- Add `memberDisplayName(hostId, hosts)` beside `serverHostName` in
  `src/bridge/server-set.ts`. It returns
  `serverHostName(hostId) ?? memberHostName(hostId, hosts)`.
- Add `hostSentenceName` for `hostLabel`'s lowercase sentence form.
- Components use `useServerHostName`, or a hook built on the new helper, so
  names update when pairings change. Store functions call the helper once,
  which is fine for toasts and undo labels.
- Every site in R8 switches over. On the desktop the strings stay "This
  machine" and "this machine".
- **As built:** rows inside `ProjectSetUpOnSection`'s map and `TasksView`'s
  memo don't re-render on a pairing change alone; they pick up the new name
  on their next render.

### D13. Git runs on the host of the project the route resolved (R9, #269)

- `resolveGit` returns
  `deps.backendRegistry.get(normalizeHostId(match.project.hostId)).git`
  instead of `deps.backend.git`. There is precedent in
  `electron/bridge/handlers/hosts.ts:263`.
- The route's fallback stays. Removing it would bring back the 400 its test
  guards against.
- `git.test.ts`'s deps get a per-host `backendRegistry`. The issue's
  scenario then asserts that git ran on the local fake. A new test asserts
  that a box-resolved route runs git on `box`.
- An away or unregistered host fails as `RoutedBackend` fails today. The
  ticket checks this with a test.
- Close #269 from the PR.

### D14. Stats count remote agents (S1)

- The busy count reads `[...agentManager.getActiveAgents(),
  ...hostRouting.agents()]`. It is also sampled on `HostProxy`'s agent
  updates (`onRemoteAgentUpdate`, through `statsStore.recordMax`), because
  remote hook events no longer reach the desktop.
- The kill lookups fall back to `hostRouting.agents()` by pane id.
  `KillAllProcessesDeps` gains `hostRouting`.
- The desktop is the single recorder. Host servers' own `StatsStore`s are
  never read, because `stats` is desktop-only.

### D15. Delete the dead caller scoping (S2)

- Delete `electron/routes/caller-host.ts`, `callerHostId` on the route deps,
  and every relayed branch and its tests.
- Before that, replace `context.ts:101`'s `callerMaySee` with an exact-host
  compare (`normalizeHostId(p.hostId) === hostId`).
- Keep the local-caller tests.
- **As built:** `withWorkspaceHost` can no longer refuse, so it returns a
  plain body rather than a result to check.

### Scope

**In:** L1–L4, R1–R9, S1–S2, the docs that describe them, and E2E coverage
where the harness can reach.

**Out, each needing its own decision later:**
- Waking a host from the phone while the desktop is away.
- Agents resuming on their own after a reboot.
- Vendor providers and billing.
- Real-cluster testing of the Kubernetes template, and a full "lid closed"
  E2E. A separate validation ADR covers these.
- ADR-228's lookup cost (`HostProxy.layout()`, `workspaceOfPane`). This is
  not a correctness gap.
- Other recorded limits not named here:
  - older host servers lacking `pty.reset`;
  - panes attached before adoption;
  - Linear settings calls without a host;
  - grouped projects on a host-server home;
  - ADR-229's supervision, secrets and template limits.

## Consequences

**Better**
- Idle stop only stops hosts nobody is looking at.
- A recipe box that moved is found again without a manual reconnect.
- Opening Manor doesn't start a sleeping box, and its bill, just because a
  pane was on screen last time.
- Port forwards work with clients that half-close, such as HTTP/1.0-style
  clients, `nc -N` and some database drivers.
- A phone stops waiting on a dead server within 4 s.
- Branches, diffs, the selected project and Linear status on the phone are
  right for every host, not just home.
- Resizes from a phone and a desktop window on the same remote pane stop
  fighting. One phone leaving no longer detaches the others.
- No stray host devices after a reset or a lost answer.
- Multi-host git diffs use the right base branch.

**Harder**
- **Host servers run branch and diff watchers**, which adds polling on the
  box. Watchers run only for workspaces someone has asked about, as on the
  desktop.
- **The router gains a third route kind** (`split`).
- **Winsize is now decided in two layers** for routed panes: main, then the
  host. They can still disagree when a directly paired phone competes with
  main.
- **A restored pane on a sleeping host now shows the asleep banner**
  instead of starting the box. Users who relied on launch to wake it must
  press "wake it" or start work in that pane.

**Risks**
- **Re-running `up` during a reconnect** costs time (up to 15 min) on a
  recipe that rebuilds. It runs once per drop, never on the first attempt.
- **The 4 s grace period** is a guess. If it is too short on a bad network,
  the overlay flickers; if too long, calls wait. It is one constant.
- **Version skew:**
  - an older host server lacks `viewing`, `linear.connectionChanged`, the
    watchers and the device creation time;
  - each fix degrades to the old behavior on such a host;
  - the next connect's tarball upgrade brings it up to date.

## Known limits as built

**Timing and version skew**
- **The 4 s grace (D5)** is a guess, one constant (`DROP_GRACE_MS` in
  `src/bridge/transports/ws.ts`). Too short on a bad network and the
  reachability overlay flickers; too long and calls wait on a dead server.
- **Version skew.** An older host server lacks `viewing`,
  `linear.connectionChanged`, the branch and diff watchers and the devices'
  creation time. Each fix degrades to the old behavior on such a host: idle
  stop counts desktop windows only; an open phone's Linear status updates
  only on hello and pairing changes; its workspaces' branches are watched
  by a desktop that lists the host; a lost mint is matched on label alone.
  The next connect's tarball upgrade brings it up to date.

**Lifecycle**
- The `autoSleep` check lives in `RecipeHostProvider.refresh()`, and a
  declined refresh counts as this drop's re-run (D2).
- Callers that join an `ensureUp` already in flight don't get its progress
  lines (D2).
- Only the panes of the workspace a window shows at launch decline to wake.
  Opening another workspace counts as intent and wakes the host (D3).
- A restored pane id is forgotten once its first create settles. A resync's
  `attach()` never sends `wake: false` (D3).
- The router and `HostRouting` answer `{ok: false, reason:
  "host-unavailable"}` for a declined wake rather than throwing (D3).
- `forwarded` (D1) doesn't count a desktop window's own viewer stream,
  which is an owner connection too; that counts as `desktop`.

**Routing**
- **The phone's project selection on a project home doesn't hold is
  page-only** (D7): it isn't persisted across a reload.
- **A phone paired with a host directly still competes with main as a
  whole** for a pane's winsize (D10). The host decides between them as it
  did before.
- **The phone's diff-pane reads go home** (D6). Only `branches.start/stop`
  and `diffs.start/stop` are split per server; `diffs.getFullDiff`,
  `getLocalDiff` and `getStagedFiles` still go to home, which answers only
  for the hosts it knows.
- A server marked `refused` for the watchers (an older host server) is
  cleared only on a resync or a bridge change (D6).
- The router delivers the union of every server's branch and diff payloads,
  trimmed per server, because the consumers treat each payload as the whole
  picture (D6).
- Rows inside `ProjectSetUpOnSection`'s map and `TasksView`'s memo don't
  re-render on a pairing change alone (D12); they show the new name on their
  next render.

**Pairing links (D11)**
- `pendingMints` is a list per host. A mint still in flight is never
  reconciled.
- The `createdAt` match allows 10 min of clock skew.
- Linked pairings show a 6-hex suffix in the host's device list, for
  example "Orry's phone (a1b2c3)".
- A reset made from elsewhere is caught by the room check. A link that
  still points at the old room is replaced only on the phone's next hello.

**Code shape, for whoever reads it next**
- The forwarded-winsize grid cache lives in `HostRouting` (`ptyGrids`).
  `PtyAttachments` is a class and `processAttachments` the process's
  instance. Forwarded `create`, `attach` and `reset` answers always carry
  `winsizeOwner`. Only main's local holders of a pane get per-connection
  owner flags, and a follower that creates before any grid is cached sends
  its own size (D10).
- The branch and diff watchers live in `SharedDeps`, and the
  per-connection sets in `electron/watched-sets.ts`. `BranchWatcher`
  re-emits when a connection's own list changes (D6).
- `withWorkspaceHost` returns a plain body (D15).
- The busy-agent gauge is also sampled in `onRemoteAgentUpdate` through
  `statsStore.recordMax` (D14). That sampling has no test of its own.

**Tests**
- Phone-mode tests must sit last in `auto-join.test.ts` and
  `project-store-transfer.test.ts`: a home server can't be removed from the
  server set once added.
- **E2E added (ticket 16):**
  - recipe suite: a forced drop after the box moved re-runs `up` and finds
    the new exec target (D2); a port forward carries half-close (D4);
  - `phone-all-pairings.spec.ts`: a checkout on the box reaches a phone
    paired with the host while the desktop is stopped (D6).
- **E2E gaps, covered by unit tests only:**
  - ~~**Restore doesn't wake (D3).** The recipe suite drives the registry
    without a renderer, and the Playwright suites have no recipe host, so a
    relaunch onto a sleeping host isn't reachable.
    `src/hooks/__tests__/useTerminalConnection-restored.test.ts`,
    `electron/backend/__tests__/registry.test.ts`,
    `electron/server/__tests__/host-routing.test.ts` and
    `src/bridge/__tests__/router.test.ts` cover it.~~ Covered in ADR-231
    (`host-restore-asleep.spec.ts`).
  - ~~**Idle stop counting phones (D1):** `host-idle-stop.test.ts`,
    `events.test.ts`, `owner-channel.test.ts`. The recipe suite doesn't run
    `HostServerSync`, and the harness's host server has no relay.~~ Covered
    in ADR-231 (`host-idle-stop.spec.ts`), for the `device` class.
  - ~~**The drop grace (D5):** `ws.test.ts`, `relay-pipe.test.ts`,
    `install-web-relay.test.ts`.~~ Covered in ADR-231
    (`phone-drop-grace.spec.ts`).
  - **The selected project (D7), Linear's event (D8), remote tab claims
    (D9), forwarded winsize (D10), the pairing links (D11), names on the
    phone (D12), git on the resolved host (D13) and stats (D14):** unit and
    component tests only.
- **Flaky tests seen while building this ADR:**
  - ~~`remote-host.spec.ts` "laptop closed … one notification" on the private
    sshd: the desktop never read "thinking". 1 of 6 runs on this branch,
    0 of 5 on `b128a6fa`; not traced. Recorded in
    `docs/remote-hosts.md#testing`.~~ Fixed in ADR-231 (D5): a shell running
    a script read as the agent's process exiting.
  - Unit tests under a full parallel run that passed alone:
    `bridge-process.test.ts` ("keeps its daemon apart", twice),
    `exec-runner` and `TaskDetail` (once each). None reproduced in the
    final run.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
