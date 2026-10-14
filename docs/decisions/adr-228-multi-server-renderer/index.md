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

# ADR-228: One renderer, many servers

Slice 3 of ADR-225. Slice 1 (ADR-225, ADR-226) put a **Host server** on every
remote host. Slice 2 (ADR-227) made each host server the authority for its own
host, with the desktop as one of its clients. This slice changes the renderer:
it talks to every server it can reach, not to just one.

## Context

### Where slice 2 left the renderer

- **One bridge per page.** The renderer holds exactly one bridge, the global
  `window.electronAPI` (`src/bridge/client.ts`).
  - The desktop installs it over IPC (`src/bridge/install-desktop.ts`).
  - The web app installs it over one relay room (`src/bridge/install-web.ts`).
  - It is read at module scope 352 times, in 103 files.
- **The desktop main process does the per-host work** (ADR-227 D4).
  - `HostRouting` (`electron/server/host-routing.ts`) forwards each call
    whose method declares a `route` to that host's `HostProxy`. It rewrites
    the arguments on the way out and the result on the way back.
  - `projects.getAll`, `layout.getAll` and `agents.get*` merge local results
    with every host's proxy.
  - Host events are republished into the desktop's bus with
    `<hostId>:<path>` keys.
  - **The renderer never sees a host.** It sees a `hostId` in its data.
- **Remote writes take two hops:** renderer → desktop main → host server.
- **Remote terminal bytes take a third path.** `pty.create` goes to the host
  server. The desktop then attaches over the host's *daemon* stream
  (`RoutedBackend.createOrAttachWith`, `electron/backend/routed-backend.ts:144`),
  and `BridgeServer` republishes the bytes as `pty.output`.
  - On the host, `electron/host-server/winsize.ts` sees the desktop only as
    "another daemon client". It makes every phone a follower while that
    client is attached.
- **The phone shows one host at a time.**
  - It stores one pairing per room (`src/bridge/pairings.ts`).
  - `PhoneHostSwitcher` switches between them with `location.reload()`.
  - `src/bridge/connection.ts` says it outright: "a page serves one host".
- **One QR per host.** A phone paired with the desktop learns nothing about
  the host servers' rooms. Each host needs its own scan in
  `HostPhoneAccess`. ADR-225 lists this as a cost "until slice 3".
- **Integrations follow the page's server.**
  - Trackers call `window.electronAPI.linear.*` and `github.*` on whatever
    server the page is connected to (`src/lib/trackers/*`).
  - A phone on a host server that hasn't opted into Linear gets
    `linear.isConnected() === false`. `TasksView` then shows a generic
    "nothing connected" state, even when the desktop next to it is awake
    and holds the token.

### What ADR-225 and ADR-227 asked of this slice

- **ADR-225 "Slices after this one", item 2:**
  - the renderer holds a bridge per host, and the sidebar merges them;
  - the phone sees every paired host in one list;
  - a user-delegated integration call for a host that hasn't opted in is
    routed to the desktop's server while the desktop is awake.
- **ADR-225 end state, step 1:** one sidebar on the phone for every paired
  host.
- **ADR-227 D4 and Consequences:**
  - terminal bytes move onto the bridge once the renderer holds one per host;
  - the middle hop for remote writes goes away.

### What already helps

- **The route rules are data.** Every routed method already declares which
  argument names its host: `byProject`, `byWorkspaceKey`, `byPane`,
  `byGhRepo`, `byHost` and `byAgent` (`electron/bridge/method.ts:80-121`). A
  surface test fails on any method in a routed namespace that has no rule.
- **The rewrite is known and tested.** `HostProxy.toHostArgs` and
  `toDesktopResult` (`electron/backend/host-proxy.ts:655-715`) turn a key
  into a bare path and `local` into a hostId, and back again.
- **The web transport already has the shape a second bridge needs.**
  `createWsTransport` (`src/bridge/transports/ws.ts:505`) runs over any
  `Pipe`. It brings hello, reconnect with backoff, a probe and replayed
  subscriptions.
- **A host server takes any number of connections**
  (`electron/host-server/socket.ts:126`). Each extra `server-bridge` SSH child
  is another authenticated connection.
- **The stores already hold merged data.** Projects carry `hostId`. Layouts
  are keyed by workspace key. Agents carry `hostId`. A renderer that merges
  several bridges can produce exactly what the stores hold today.

## Decision

### D1. The renderer's bridge is a router over a set of servers

`window.electronAPI` stays the one interface that renderer code calls. The
103 files that call it do not change. What sits behind it changes, from one
transport to a **router** over a **server set**:

- **`src/bridge/server-set.ts`.** It holds one entry per Manor server the page
  can reach. Each entry has:
  - its id, which is a renderer host id (D2);
  - its own `createBridge(transport)`;
  - its reachability;
  - its hello facts (name, `hostServer`, version, capabilities).

  This replaces the singletons in `connection.ts` and `install-web.ts`
  (`activeRoomId`, `isHostServer`, the outcome and reachability state).
- **`src/bridge/router.ts`.** It builds the `ElectronAPI` `Proxy` that
  `window.electronAPI` becomes. For each call it does one of the following:
  - **Routed.** The method has a route rule. The router reads the target host
    from the argument the rule names, resolves it against the renderer's own
    stores (which project, pane, agent or workspace key lives where), rewrites
    the arguments, calls that server's bridge, and rewrites the result.
  - **Merged.** The method is a merged read (`projects.getAll`,
    `layout.getAll`, `layout.getLastActive`, `agents.get*`,
    `agents.getPaneStatuses`). The router calls every reachable server and
    merges the results. A server that is away contributes its last-known
    answer (D6).
  - **Home.** Everything else goes to the page's **home server**:
    - on the desktop, the local Manor server in Electron main;
    - on the phone, the desktop it is paired with, if any, or else the most
      recently used pairing.

    Preferences, theme, notifications, remote control, settings and the
    native namespaces are all home calls.
- **Events.** A subscription (`layout.onChanged`, `agents.onUpdate` and so
  on) is opened on every server in the set and rewritten on the way in.
  - A server that joins later gets the existing subscriptions replayed.
  - `pty.*` and `chat.*` subscriptions are keyed by pane, and go only to that
    pane's server.
- **One source of route rules, two readers.**
  - The rules move from the handler tables into a renderer-importable
    manifest, `electron/bridge/routes.ts`. It follows the pattern of
    `local-only.ts`, which already mirrors `localOnly` for the browser.
  - The manifest maps `ns.method` to a `RouteRule`, `"merge"` or `"home"`.
  - `HostRouting` in main and the router in the renderer both read it.
  - The surface test asserts that each table and the manifest agree.
- **One rewrite, two callers.** `HostProxy`'s argument and result rewriting
  moves into a pure `electron/bridge/host-rewrite.ts`, which main and the
  renderer both import.
- **Resync is per server.** A resumed hello on any one bridge emits a
  resync. Stores reload with merged reads, as they do today.
- **Writes to a host that is away** are refused by the router with the
  existing `unavailable:host-away` code. `handleBridgeUnavailable` already
  turns that into a toast.

Rejected: **give every store a `hostId` dimension and per-host loaders.**
The stores already hold merged data. Merging in one place, under the
interface they already call, changes one module instead of 103 files.

Rejected: **keep merging in main and give only the phone a router.** The
phone needs a renderer-side merge anyway: it has no desktop to merge for it
while the lid is closed. Two merges would drift apart. This way the desktop
and the phone run the same router code. Main's merge stays only for callers
that hold one bridge (D7).

### D2. Renderer host ids

The router stamps every project, agent and workspace key with a **renderer
host id**. These match what the stores hold today, so nothing persisted on
the desktop changes.

- **On the desktop:**
  - the local server is `local`;
  - each host server is the desktop's own hostId for that host
    (`PersistedHost` id).
  - Keys stay `<hostId>:<path>`.
- **On the phone, every server is named by its room:**
  - A server's own `local` becomes that room's id.
  - A remote host that the phone sees only through a desktop becomes that
    host's room id, if the desktop reports one. Otherwise it becomes
    `<desktop room>~<hostId>`. (`~`, not `/`: `workspaceKey` can't hold a
    `/` in a host id.)
  - To report it, `hosts.list` gains `roomId`, read from
    `hostServer.status()`.
- **The phone's per-browser viewport keys change once.** The phone used to
  serve one room per page. The cost of the change is one reset of the
  phone's remembered tab per workspace.

### D3. Which server answers for a host

Each remote host has one **source** at a time. The source is the first
reachable server in this list:

1. **A direct bridge to that host's server.**
   - On the desktop: an SSH viewer stream (D4).
   - On the phone: its own pairing with that host's room.
2. **A desktop that lists the host**, through that desktop's `HostRouting`.
   This is slice 2's path, and it is unchanged.
3. **No source.** The host shows as away, with its last-known state (D6).

A host's data never arrives through two sources at once. The router drops a
desktop's merged entries for any host that currently has a direct source.

- **Project groups.** Groups are desktop state (ADR-227 D2). The router
  takes group membership from the desktop's `projects.getAll`, and each
  member's own fields from that member's source.
  - With the desktop away, a phone shows each member as a project of its own
    under its host. It can't know about the group.
- **Old host servers.** A host server that doesn't report the
  `viewer-bridge` capability in `hostServer.status()` has no direct source on
  the desktop. It is reached through `HostRouting` until its next upgrade.
  The same applies to a host that hasn't been adopted yet.

### D4. The desktop renderer holds an SSH viewer stream to each host server

- **The stream.** Main opens one `ssh -T <target> 'exec manor-host
  server-bridge --viewer'` per window per host. It goes through the
  `HostTransport` the host already uses, so it shares the ControlMaster with
  the owner channel and the daemon streams.
  - `server-bridge --viewer` authenticates exactly as the owner channel
    does, from the 0600 token file. SSH is the authentication.
  - Its hello marks the connection as a desktop viewer:
    `{type:"hello", token, viewer:"desktop"}`.
  - The caller class is `owner`. A desktop window is already trusted with
    `LOCAL_ONLY` methods on its own server, and an owner on a host server is
    the same user.
- **Main carries frames and nothing else.** A new native preload namespace,
  `hostPipe`, has `open(hostId)`, `send` and `close`, plus a frame event.
  - Main splits the stream's NDJSON into text frames for the renderer. It
    doesn't parse or route them.
  - Streams close with their window, and when the host is lost.
- **On the renderer side** there is a new pipe, `src/bridge/transports/host-pipe.ts`.
  It goes under the existing `createWsTransport`, which brings backoff,
  probe and subscription replay. The transport gains a `preAuthenticated`
  option: `server-bridge` already said the hello, so the transport waits for
  the hello reply instead of sending a token.
- **The server set on the desktop** comes from `hosts.list`. It gets one
  entry per host that is adopted and reports `viewer-bridge`. Entries are
  added and removed on `hosts.onStatusChanged`.
- **Hops.** Writes and reads for a remote host now go renderer → host server.
  Main only moves bytes between IPC and SSH, which it has to do anyway: a
  renderer can't open SSH itself.

Rejected: **a WebSocket from the renderer to a forwarded port** (`ssh -L`).
It would need the owner token in the renderer, and a listening port on the
laptop. `server-bridge` keeps the token on the box.

Rejected: **one viewer stream per host, shared by every window.** Per-window
streams keep one bridge connection per viewer. Winsize ranking and layout
command origins are already per connection. Detached windows are few, and
ControlMaster makes the extra children cheap.

### D5. Terminal bytes travel on the host's bridge

- **Both renderers.** For a remote pane, every `pty.*` call goes to the
  pane's source by the `byPane` rule: create, attach, write, resize,
  claim-winsize, detach and reset. The `pty.output`, `resized`, `exit`,
  `cwd`, `error` and `winsizeOwner` subscriptions go there too. This is
  already how a phone on a host server works (`electron/host-server/handlers.ts:436-445`).
- **Winsize ranking moves into the host.**
  - `pty-attachments.ts` ranks a `viewer:"desktop"` connection like `local`,
    above devices.
  - "The desktop app is winsize owner while it has the pane mounted" stays
    true, and is now decided by one registry on the host.
  - The daemon-level foreign hold (`winsize.ts`) still covers any other
    daemon client. The desktop is no longer one of them.
- **The desktop stops attaching remote panes over the daemon stream.**
  - `RoutedBackend`'s remote attach path for adopted hosts is deleted.
  - A device paired only with the desktop (D3, source 2) still needs bytes
    for a remote pane. Main forwards its `pty.*` through `HostRouting` by
    `byPane`, and `HostProxy` republishes the host's `pty.*` events keyed by
    pane.
  - The desktop's daemon connection to an adopted host remains for host
    lifecycle only: `ensureRunning`, the tarball upgrade, port forwards and
    the control relay.

### D6. Away hosts

- **Reachability is per server.** The server set reports
  connected / connecting / unreachable for each entry. On the desktop,
  `HostOfflineBanner`, `isHostOffline` and `HostAlert` read the host's
  source state rather than only `hosts.list`. For a remote host they are
  the same fact, now from one place.
- **Last-known state.**
  - **Desktop.** When a direct source goes away, the router falls back to
    the desktop's own `HostRouting`, which serves `HostProxy`'s cache
    (`~/.manor/host-cache/<hostId>.json`). The sidebar looks as it does in
    slice 2.
  - **Phone.** The router keeps each server's last merged answers in memory,
    and in IndexedDB per room, so a reload with the host unreachable still
    shows its projects, dimmed. Writes are refused (`unavailable:host-away`),
    as on the desktop.

### D7. What main keeps

- **`HostProxy` stays.** Main needs remote state for:
  - desktop notifications and the dock badge;
  - the push dedupe;
  - group write-through (ADR-227 D2);
  - the MCP and CLI routes;
  - the away cache.
- **`HostRouting` and main's merged reads stay**, for callers that hold one
  bridge:
  - a device paired only with the desktop;
  - the MCP and CLI routes;
  - the desktop renderer's fallback for a host with no direct source (D3).
- **Both read the same route manifest and rewrite module (D1).** So the
  rules cannot differ between main and the renderer.
- **Claims and detached windows.** `layout.reportViewport` for a remote
  workspace goes to the **home** server. A claim is a desktop-window fact,
  so the desktop's `LayoutStore` keeps it. This fixes the ADR-227 known limit
  "detached-window viewport claims for a remote workspace are lost".

### D8. The phone holds every pairing at once, in one list

- **`install-web.ts` opens one relay bridge per stored pairing** (D1 server
  set). It no longer opens only the last-used one.
  - `readPairing()` still adds a pairing from a fresh link.
  - The 4401 refusal still forgets only that room.
- **One sidebar.** Projects from every server are merged and labelled with
  their host, as linked groups and remote projects are on the desktop.
  `ProjectItem` and `ProjectGroupItem` already render a host row.
- **`PhoneHostSwitcher` and the reload are deleted.** They are replaced by a
  **Hosts** sheet, opened from the phone drawer's bottom nav. The sheet:
  - lists each pairing with its name and reachability;
  - renames a pairing;
  - removes a pairing, with a confirm.
- **Commands and the new-agent target picker** (ADR-222) list workspaces
  from every server. A launch goes to the workspace's source.
- **Push is unchanged.** There is one VAPID key and one endpoint, and the
  per-endpoint dedupe still applies (ADR-225 D3).

### D9. One pairing covers every host

ADR-225 noted "one QR per host until slice 3". This slice removes that.

- **A new desktop method, `remoteControl.linkHostPairings(heldRooms)`,**
  callable by a device. For each host server the desktop can reach whose
  room is not in `heldRooms`, the desktop:
  1. mints a pairing on that host over the owner channel
     (`remoteControl.pair`), labelled with the device's own label;
  2. records the link `deviceId → [{hostId, hostDeviceId}]` in the device
     store;
  3. returns `{roomId, serverKey, token, name}` to the device, inside the
     device's own Noise channel.
- **The phone calls it on every hello from a desktop**, and upserts what
  comes back. A host added later, or one that was away at pairing time, is
  therefore picked up on a later connect.
- **Revoking cascades.**
  - Revoking a device on the desktop also revokes its linked pairings on
    each host. A host that is away at that moment is revoked on its next
    connect.
  - **Reset pairing keys** on a host still drops every phone paired there.
    The next `linkHostPairings` call then mints fresh pairings for phones
    that are still paired with the desktop.
- **Why a device may call it.**
  - A `full` device on the desktop can already reach every host through
    `HostRouting`. A direct pairing adds no reach. It only adds the ability
    to reach the host while the desktop sleeps.
  - The desktop never hands out a host pairing to a device it hasn't paired
    itself, and the link makes revoking it complete.
- **Opting out per host.** `HostPhoneAccess` gets a "Phones paired with this
  Mac can reach \<host\>" switch, on by default. Off means
  `linkHostPairings` skips that host and revokes its linked pairings.

### D10. Integrations pick their server per call

The router routes tracker calls by **integration class** (ADR-225 D8). It
does not send them to the page's server.

- **GitHub is host-native.** `github.*` calls with `byGhRepo` and `byHost`
  rules go to the repo's host source, as every routed call does (D1).
- **Linear is user-delegated.** `linear.*` calls aren't tied to a path. They
  are browse, detail, viewer, teams, `proxyImage`, `autoMatch` and the
  tracker-side `startIssue`. For a call made on behalf of host H, the router
  picks the first of:
  1. **H's own server**, if it reports Linear connected (H opted in,
     ADR-227 D7);
  2. **the desktop that lists H**, if it is reachable and has Linear
     connected. This is the route ADR-225's end-state table asks for. The
     token never leaves the desktop.
  3. **Neither.** The call is refused with a stated reason: "Linear isn't
     turned on for wsl-box, and This Mac is away". Each server is named as
     away when it is unreachable, and as lacking Linear otherwise; two away
     servers read "wsl-box and This Mac are both away". On the desktop the
     home server is never away, so there it reads "…and Linear isn't
     connected on This Mac".
- **Linking an issue to a workspace stays host-native.** That is
  `linear.linkIssueToWorkspace` by `byProject`. The link is project state,
  so it goes to H whichever server answered the browse.
- **Auto-matching teams is split the same way.** `linear.autoMatch` is a
  delegated read: it takes `{id, name}` candidates and returns matches
  without writing. Each match is written by `linear.associateProject`
  (`byProject`) to the project's own source, or by `projects.updateGroup` on
  home for a grouped project, since groups are desktop state
  (`src/lib/linear-auto-match.ts`).
- **Browsing with no host in mind**, as in `TasksView`: the router asks the
  home server first, then any server with Linear connected.
  - `useTrackerStatus` reports Linear as connected if any reachable server
    has it.
  - When none does, it says why ("Linear isn't connected on This Mac, and
    no host has it turned on"), not a generic "nothing connected".
- **How the manifest says so.** The path-free `linear.*` methods get a new
  rule in `routes.ts`, `{by: "delegated", provider: "linear"}`. The router
  applies the choice above. Main's `HostRouting` treats the rule as local,
  as it does today.
- **On the desktop** this changes nothing a user sees. The desktop's own
  server is always reachable and already holds the token.

### Scope

**Out of scope**, deferred to later work:
- Hosts we start ourselves (slice 4).
- Sharing a viewport across devices.
- Two desktops paired with one phone, beyond what D3 already gives. Each is
  a server in the set, and a host listed by both is sourced by whichever
  reachable one comes first.

## Consequences

**Better**
- **ADR-225 end state, step 1.** One phone sidebar shows every host,
  including with the lid closed for hosts that are awake.
- **One QR.** Pairing a phone with the desktop pairs it with every host, and
  revoking it unpairs every host.
- **Remote writes and terminal bytes take one hop** from the renderer to the
  host server. Main only moves bytes between IPC and SSH.
- **Winsize has one decider** for every viewer of a remote session: the
  host's attachment registry. The daemon-level guess no longer has to infer
  the desktop.
- **Linear works on the phone for a host that hasn't opted in**, while the
  desktop is awake, and the token stays on the desktop.
- **Detached-window claims for remote workspaces work again** (D7).

**Harder**
- **Two routers, one rule set.** Main's `HostRouting` and the renderer's
  router both exist. They share the manifest and the rewrite, and a test
  pins that the tables agree with the manifest. A new routed method still
  has to declare its rule once.
- **The router is now the renderer's most important module.** A routing bug
  sends a write to the wrong host. The router gets the same fake-transport
  unit tests `HostRouting` has, and an E2E covers a desktop with a local and
  a remote host.
- **More connections.**
  - The desktop: one SSH child per window per host, on top of the existing
    three per host.
  - The phone: one relay channel per paired room while the page is open.
    Relay cost grows with hosts × devices, as ADR-225 predicted. The
    per-room byte budget still caps each room.
- **Merged reads cost one call per server.** A `projects.changed` from any
  server reloads the merged list from every server. This is cheap at a few
  hosts. Per-source incremental reloads are a later optimisation.

**Risks**
- **Pane-id collisions across servers.** The router keys `pty`
  subscriptions by server and pane. Pane ids are random, but a collision
  would cross-wire two terminals. The router keys by both, and refuses a
  duplicate pane id across servers.
- **A delegated pairing outlives a missed revoke.** If a host stays away
  forever, its linked pairing is never revoked. **Reset pairing keys** on
  that host is the recovery step, as it is today.
- **Old host servers.** Until a host upgrades, it is reached through main
  (D3). Both paths must keep working. The E2E covers both.

## Built beyond the tickets

Three behaviours shipped that no ticket named. Each was needed to make a
named one work.

- **The renderer holds pending commands (D5, D7).** Main's `HostRouting`
  used to move a `layout.setPendingCommand` to the host whose `layout.apply`
  added the pane (`movePendingCommands`). A direct bridge skips main, so the
  router does the same: it holds the command for a pane no layout holds yet,
  sends it ahead of the `layout.apply` that names the pane, and sends it home
  if none comes within `HOLD_PENDING_MS` (`src/bridge/router.ts`,
  `holdPendingCommand`).
- **A keystroke lost mid-flight is dropped, not resent (D5).** A `pty.write`
  whose direct bridge isn't connected goes through home, which forwards it to
  the host (ticket 6 asked for this fallback). A write that was in flight when
  its stream dropped may or may not have reached the host, so the router logs
  it and lets it go rather than risk typing it twice. Nobody awaits a
  keystroke, so nothing else sees the error.
- **The terminal daemon only removes its own socket and pid file.** On
  shutdown, the daemon unlinks them only while its pid file still names it
  (`electron/terminal-host/index.ts`, `ownsPidFile`, and the matching check
  in `transport-local.ts` `stop()`). Without it, a daemon started by a host
  server that reconnected during a slow scrollback flush lost its socket to
  the old daemon's cleanup, and the next client started a second daemon. The
  direct-bridge E2E exposed the race.

## Known limits as built

Fixed during slice 3 and no longer limits: the re-mint of a declined host
room, away state for a host reached only through a desktop (icon, chip and
terminal write guard), "This machine" labels in the main phone screens, and a
source stuck "unknown" when it never says hello (now a 15 s first-hello
deadline in `install-web.ts`).

Still true:

- **Main's forwarded callers share one host viewer.** Phones on the desktop
  and windows that fell back all use main's owner channel for a remote pane,
  so they get one `winsizeOwner` and can fight over resizes
  (`electron/server/host-routing.ts`, `electron/backend/host-proxy.ts`).
- **Claims on remote tabs** that leave the host's tree aren't dropped on
  main; `dropClaimsOnGoneTabs` (`electron/layout/layout-store.ts`) runs for
  local workspaces only. The claim lasts until the window closes.
- **Lookup cost.** `HostProxy.layout()` copies entries and calls `claimsFor`
  per call, and `workspaceOfPane` runs per routed pane call, keystrokes
  included. Fine at today's sizes; index it later.
- **Older host servers** lack `pty.reset` and `pty.close` until their tarball
  upgrade runs.
- **Panes attached before adoption** in the same run keep their daemon
  subscription until main restarts (`electron/backend/routed-backend.ts`).
- **Branch and diff watching on the phone.** `branches.start` and
  `diffs.start` go home only, and home drops workspaces for hosts it doesn't
  know, so watching is off for workspaces that exist only on a host server.
  Fix: split per server and merge events.
- **Selected project.** `projects.getSelectedIndex` and `select` index home's
  list, not the merged one.
- **A source that drops after connecting** with a close code the relay pipe
  doesn't treat as unreachable (e.g. 1006) keeps its last reachability while
  it redials, so its calls and pane listeners stay on it until the relay
  says 4404 or 4410 (`src/bridge/transports/ws.ts`, `src/bridge/install-web.ts`).
- **Reset mid-mint.** A host-server reset while `linkHostPairings` mints can
  leave the minted host device unlinked (`electron/remote-control/host-links.ts`).
- **Linear without a host.** Settings and wizard calls (`getViewer`,
  `getTeams`, `autoMatch`) pass no host and use browse order, home first.
- **Grouped projects on a phone whose home is a host server.** Auto-match
  writes a grouped project's team to its group on home; when home isn't a
  desktop that write is refused, logged and skipped, as editing project
  settings there already is.
- **D10 E2E reach.** The phone E2E proves a call on behalf of a host is
  answered by the desktop, but can't tell it from a browse (the desktop would
  answer both), and the refusal for a host call is covered by unit tests
  only: with the desktop gone, Tasks shows its setup hint instead.
- **Stale Linear status on an open phone.** `src/bridge/linear-servers.ts`
  caches each server's `isConnected` and refreshes it only on hello and
  `hosts.pairingChanged`. Connecting Linear on the desktop isn't seen by an
  open phone until it reconnects or reloads.
- **"This machine" elsewhere.** `memberHostName` still says so on the phone in
  `src/store/auto-join.ts`, `src/store/project-store.ts` toasts and undo
  labels, `ProjectItem.tsx`'s menu, `ProjectSetUpOnSection.tsx` and
  `ProjectSettingsPage.tsx`.
- **E2E.** `web-app.spec.ts` tests at lines 255, 470 and 566 fail on the base
  commit too; they are not caused by this ADR.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
