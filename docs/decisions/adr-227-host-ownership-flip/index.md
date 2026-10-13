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

# ADR-227: The host owns its host

Slice 2 of ADR-225. Slice 1 (ADR-225, with the ADR-226 review fixes) put a
headless **Host server** on every remote host. The phone can see and steer
that host's agents with the laptop closed, but it can't change anything there.

## Context

### Where slice 1 left ownership

ADR-225 D2 kept the desktop as the owner of everything that can change, and
made the host server a reader:

- **Projects and workspace metadata.** They live in the desktop's
  `projects.json`. The desktop pushes them to the box as a **manifest**
  (`hostServer.syncManifest`). The box caches the manifest in
  `OwnerSnapshotStore` and rebuilds `ProjectInfo` from it, using its own
  `git worktree list`.
- **Layout.** It lives in the desktop's `layout.json` and is pushed as a
  filtered snapshot (`hostServer.syncLayout`). Sessions started after the last
  push are grafted on under "Started while away".
- **Agents.** There are two readers of one hook journal: the desktop's
  `HostHookFeed` inside `RemoteHostConnection`, and the host server's own
  feed. A test (`two-readers.test.ts`) pins that they agree.
- **Integrations.** The desktop runs `gh -R owner/repo` for remote projects,
  using a `RemoteRepoResolver`, and holds the Linear token. The manifest
  carries a stamped issue and PR snapshot, but nothing on the box reads it.

### What that costs

- **The phone can't create anything with the lid closed.** The host server
  never spawns a session: `hostPtyCreate` only attaches
  (`electron/host-server/handlers.ts:153`). The host table also leaves out
  `layout.apply`, `projects.createWorktree` and all of `github.*` and
  `linear.*`. The phone shows "not available on \<host\> yet" for each
  (`src/lib/commands.ts:434-449`, `src/lib/keybinding-commands.ts:140`).
- **Launches need a renderer.** On the desktop too, an agent launch or setup
  script is only a pending command plus a new tab. Nothing runs until a
  renderer mounts the pane and calls `pty.create`; setup scripts even go
  through the `run-setup-script` app command to the primary window
  (`electron/renderer-bridge.ts:190`). A host with no renderer attached could
  never start one.
- **Manifest drift.** A project set up on the box while the desktop was away
  stays invisible to the phone until the desktop reconnects.
- **The box's own `manor` CLI goes through the desktop.** `manor
  create-workspace` on a remote host travels through the daemon's control
  relay to the desktop, and fails with "Manor desktop is not connected to
  this host" while the lid is closed.
- **Two server compositions.** `initApp()` (`electron/app-lifecycle.ts:135`,
  ~980 lines) and `createHostServer()` (`electron/host-server/server.ts:151`)
  each build `TerminalHostClient`, preferences, theme, `AgentManager` and the
  agent pipeline, `ChatMirror`, the stream fan-out, `BridgeServer` and the
  relay stores. Two things block a shared core:
  - **`HostDeps` carries `BrowserWindow`.** Every desktop handler is typed
    over it (`electron/ipc/types.ts:52`).
  - **Several modules assume one server per process.** These include
    renderer-broadcast's sink list, the `unseen*` sets and store setters in
    `notifications.ts`, and `emitSetupProgress` writing to the global
    broadcast.

### What already helps

- **`ProjectManager`, `LayoutStore`, `workspaceOps`, `GitHubManager` and
  `LinearManager` import no Electron.** On the box, `GitHubManager` built
  with no resolver runs `gh` in the checkout with the box's own sign-in. That
  is exactly ADR-225 D8's host-native case.
- **`LinearManager` already takes a `SecretBox`.** It only needs its token
  path made a parameter.
- **The host already keeps its own `agents.json`.** It runs the full agent
  pipeline from the journal (`electron/host-server/agents.ts`). Deleting the
  desktop's replay therefore means switching the desktop's *source* for
  remote agents. The pipeline itself stays.
- **The owner channel exists.** `HostServerClient` speaks the bridge protocol
  over SSH as caller class `owner`, but it handles result frames only and has
  no events yet.

## Decision

### D1. `createManorServer(platform)`: one composition, two platforms

There is a new `electron/server/`. It holds `createManorServer(platform):
ManorServer`, which builds every part that both servers share:

- the daemon client and local backend
- preferences and theme
- `ProjectManager`
- `LayoutStore` and `LayoutPersistence`
- `workspaceOps`
- `AgentManager` and the agent pipeline
- `ChatMirror` and the stream fan-out
- `GitHubManager` and `LinearManager`
- the relay stores (`RemoteDeviceStore`, `PushManager`, `RelayIdentityStore`)
- a per-server `BroadcastBus`
- `BridgeServer`
- ordered start and stop

`Platform` is the seam for what differs. It is an interface, not an
`if (headless)`:

| Port | Desktop (Electron) | Host server |
|---|---|---|
| `dataDir` | `manorDataDir()` | `~/.manor/remote/server/` |
| `secretBox` | `electronSecretBox` | `pickHostSecretBox()` |
| `appVersion`, `hostName` | `app.getVersion()`, `os.hostname()` | tarball version, `os.hostname()` |
| `daemonTransport` | local socket, may restart the daemon | namespace `remote`, never restarts it |
| `notifier` | desktop notification and dock badge | none (push is the only channel) |
| `windows` | `isPrimary`/`claimOf` for `LayoutStore`, renderer list | absent |
| `remoteHosts` | `BackendRegistry` with SSH hosts | absent (a host has no hosts of its own) |

- **`initApp()` becomes `createManorServer(electronPlatform)` plus
  Electron-only parts.** Those are windows, the menu, IPC modules, the webview
  server, portless, the updater, `powerMonitor` triggers and the hook HTTP
  server.
- **`createHostServer()` becomes `createManorServer(hostPlatform)` plus
  host-only parts.** Those are the owner socket, the winsize hold and the
  always-on relay room.
- **`HostDeps` splits.** `ServerDeps` is window-free and is what the shared
  handlers are typed over. `DesktopDeps` (windows, menu, webview server) is
  added only by the desktop. `HostDeps` stays as `ServerDeps & DesktopDeps`,
  so desktop-only handlers don't churn.
  - `preferences.ts` and `app-commands.ts` stop importing `notifications.ts`
    and `renderer-bridge.ts`. They reach the sound and app-command sinks
    through the platform instead.
- **Process globals become server state.** This covers the broadcast sinks,
  `unseenInputAgents` / `unseenRespondedAgents`, `setNotificationStore` /
  `setStatsStore` and setup-progress publishing. Two servers in one process
  (the test harness) then share nothing.
- **The tables share one method list.**
  - `SERVER_METHODS` is typed over `ServerDeps`.
  - `DESKTOP_TABLE` is `SERVER_METHODS` plus the desktop namespaces.
  - `HOST_TABLE` stays an **explicit allowlist** (ADR-225 D6). It now names
    shared handlers rather than host copies, plus the owner-only
    `hostServer.*` methods.
- **The Electron-free bundle test** (`electron/platform/__tests__/electron-free.test.ts`)
  bundles `electron/server/` as well as `electron/host-server/index.ts`.

### D2. The host server is the authority for its host

After this ADR, the host server owns:

| State | Lives in (on the box) | Notes |
|---|---|---|
| Projects checked out on the host, including workspace names, order, issues, folders and hidden flags | `projects.json` in the server data dir | Every record is `hostId: "local"`; to the host, its own host is local |
| Workspaces (worktrees) | git, plus the above | Created and removed by the host's `workspaceOps` |
| Layout of those workspaces | `layout.json` | A real `LayoutStore`, keyed by bare paths |
| Agents | `agents.json` | Already there; now the only copy |
| Hook journal reading | `hook-cursor.json` | The only reader |
| Pairings, push, relay identity, delegated tokens | sealed stores | As in slice 1, plus the Linear token (D7) |

The desktop keeps:
- local projects;
- the list of remote hosts (`PersistedHost.spec`);
- **project groups**. Linking spans hosts, so only the desktop sees all
  members. `memberIds` reference project ids, and those ids survive
  adoption (D3).
  - Shared fields (color, agent command, Linear associations, theme,
    commands) are written through to each member's host as ordinary project
    updates. A host project therefore always holds its own resolved copy and
    can launch an agent without the desktop.

**Deleted with the flip:**
- the manifest and `hostServer.syncManifest`
- `hostServer.syncLayout`, `OwnerSnapshotStore`, `paneContextFrom(manifest…)`
  and "Started while away" (every session on the host now starts through the
  host, so its layout already has it)
- `integrationSnapshot`

`hostServer.setVapidKeys` and the push-endpoint dedupe stay.

### D3. Adoption: moving a host's records onto the box

Moving records works like Orca's runtime conversion. It runs once per host,
over the owner channel:

1. **The host server reports `ownership: "pending"`** in `hostServer.status()`
   until it has been adopted. Until then it serves no project or layout
   writes, and its `projects.getAll` is empty.
2. **The desktop sends the host's records** on the first owner connect that
   sees `pending`: `hostServer.adopt(bundle)`.
   - **Projects:** the host's projects from `projects.json` as `ManifestProject`
     records, with their workspace metadata. `hostPaths` is dropped and group
     shared fields are resolved, as `manifestRecords()` already does.
   - **Agents:** that host's entries from `agents.json`.
   - **Layout:** that host's `layout.json` entries, rebased from
     `<hostId>:<path>` to bare paths, with claims cleared, as
     `hostLayoutSnapshot()` already does.
3. **The host merges by id and wins on conflict.** It writes all three files
   atomically, then answers `ownership: "host"`. Merging makes a resend
   harmless.
4. **Only after that ack** does the desktop remove the entries locally.
   - It first writes a backup to `~/.manor/backups/pre-adr-227-<hostId>.json`.
   - It then marks `PersistedHost.adopted: true`.
   - A crash between steps 3 and 4 leaves both copies. The next connect sees
     `host`, skips the send and finishes step 4.
5. **Later connects are reads.** A desktop with leftover local entries for an
   adopted host (a second laptop, an old backup restored) sends them once
   through the same merge, so they are added and never overwrite.

A host that has never been connected adopts an empty bundle the first time a
project is set up on it.

*As built (ticket 6):*
- **No step-5 resend from an adopted desktop.** A desktop that is already
  `adopted` does not resend leftovers. Until tickets 8 and 9 land, the
  desktop still writes some records for an adopted host locally, and
  resending would hand those over and delete them on every reconnect. A
  second laptop is not `adopted`, so it still sends through the merge.
- **Crash recovery resends.** The merge can't overwrite anything, so
  resending is harmless.
- **Group ids survive a reload.** Adopted project ids are kept in
  `PersistedHost.adoptedProjectIds`, so groups don't prune them on load.


### D4. The desktop is a client of each host server

The desktop reaches a remote host's state only through that host's server.
It never goes through the daemon for state.

- **Events on the owner channel.** `HostServerClient` gains subscribe and
  event frames. A per-host `HostProxy` subscribes to the host's
  `projects.changed`, `layout.changed`, `agents.updated` and `chat` events.
  It republishes each one into the desktop's bus with paths rewritten to
  `<hostId>:<path>` workspace keys and `hostId` stamped on projects and
  agents.
- **Route declarations on methods.** A shared method can declare `route` in
  its rules: `byProject(i)`, `byWorkspaceKey(i)`, `byPane(i)` or `byGhRepo(i)`.
  - **Remote target:** the desktop's `BridgeServer` forwards the call to that
    host's proxy, with the arguments rewritten (key to bare path, hostId to
    `local`), and rewrites the result back.
  - **Local target or no `route`:** the desktop handles it as today.
  - **Merged reads.** `projects.getAll`, `layout.getAll` and `agents.get*`
    merge local results with every host's proxy.
- **Offline hosts.**
  - **Reads come from cache.** Each proxy keeps the host's last projects,
    agents and layout in `~/.manor/host-cache/<hostId>.json`, which replaces
    `LastKnownWorkspaces` for remote hosts. The sidebar shows an away host as
    it does today.
  - **Writes are refused.** A write to a host that is away answers
    `unavailable:host-away` ("wsl-box is offline"). There is no queueing:
    there is nowhere safe to reconcile it.
- **The control plane goes to the host and the data plane stays put.**
  - **Starting a session.** `pty.create` for a remote pane goes to the host
    server, which spawns the session and delivers any pending command (D5).
  - **Terminal bytes.** The desktop then attaches over the daemon stream
    exactly as today. Byte throughput and the winsize rules don't change.
    Moving terminal bytes onto the bridge waits for slice 3, when the
    renderer holds a bridge per host.
- **Deleted on the desktop:**
  - the remote `HostHookFeed` in `RemoteHostConnection`, `hookSeqStore` and
    `PersistedHost.lastHookSeq` / `hookJournalEpoch` (dropped on load)
  - `HookJournalPtyBackend` on the desktop side (the box keeps
    `client.replayHooks`)
  - `RemoteWorktreePoller`
  - the remote `RemoteRepoResolver`
  - the manifest and layout sends in `HostServerSync`

  The host-resumed announcement waits for the proxy's first snapshot rather
  than for a journal catch-up.
- **Desktop notifications for remote agents.** These now come from the
  proxy's `agents.updated` transitions. The push dedupe (ADR-225 D3) is
  unchanged.
- **Unchanged:** project moves and transfers between hosts (`host-move.ts`,
  `host-transfer.ts`). They keep their flow, but each end becomes a project
  call to that host's server, not a `projects.json` edit.

### D5. Launches run on the server, not in a renderer

This change applies to both platforms, through `createManorServer`:

- **Agent launch.** `startAgentInWorkspace` and `layout.apply(new-tab)` with
  an `agent-startup` pending command **spawn the session on the server right
  away**. The server calls `createSession` for the new pane, delivers the
  command, and records the pane's session in `LayoutStore`.
  - A renderer that mounts the pane later attaches; `createOrAttach` is
    already idempotent on the session id.
  - A host with no viewer still starts the agent.
- **Setup scripts.** `workspaceOps.create` runs the setup script the same
  way, in a new tab whose pending command is `script; exit`. The
  `run-setup-script` app command and the renderer's `startSetupScript` are
  deleted. Progress still goes out as `onWorktreeSetupProgress`, now through
  the server's own bus.
- **Pane context is derived on the server.** It comes from `ProjectManager`
  plus `LayoutStore` (which project and workspace own a pane), not from a
  renderer's `agents.setPaneContext`. The method stays as an override for
  renderer-only details. A pane launched from the phone gets the right
  project and workspace in its agent record.

### D6. The phone can create workspaces and launch agents on a host server

- **These now work on a host server's table:**
  - `pty.create` (spawns)
  - `projects.*` writes: create and remove worktree, rename, reorder,
    folders, hidden, link issue, list branches
  - `layout.apply`, `layout.setPendingCommand`, `layout.setPaneTitle`,
    `layout.reportViewport`
  - `agents.setPaneContext`
- **Project-level setup stays an owner action:** adding a project and
  cloning onto the host (the desktop does these over the owner channel).
  These are `localOnlyCallers: ["owner"]`. A phone can work inside projects
  but can't add a repository to a box.
- **The renderer drops the slice-1 refusals:**
  - `hostServer: false` on `new-agent` and `new-workspace`
  - the `host-server-new-agent` toast
  - the `NewWorkspaceDialog` unavailable state
- **The ADR-222 composer** (target picker, new worktree) runs unchanged
  against a host server.
- **Refused layout writes show a toast.** `sendLayoutCommand` and
  `sendPendingCommand` route refusals through `handleBridgeUnavailable`
  instead of only logging. This covers a host that is away, or a method a
  host still refuses.

### D7. Integrations on the host (ADR-225 D8, applied)

- **GitHub is host-native.**
  - The host server composes `GitHubManager()` with no resolver, and the host
    table allows `github.*`. Calls run `gh` in the checkout with the box's own
    sign-in.
  - `github.checkStatus` drives a stated **"gh isn't signed in on
    \<host\>"** empty state, not an error.
  - The desktop's `github.*` calls for a remote repo route to that host
    (`byGhRepo`), so PR badges for remote workspaces use the box's `gh` too.
    This is a behavior change for users whose laptop has `gh` and whose box
    doesn't; the stated empty state covers it.
- **Linear is user-delegated, and opt-in per host.**
  - `LinearManager` takes its token path as a constructor parameter;
    `hostServerPaths()` gains `linearToken`.
  - A new owner method, `hostServer.setLinearToken(token | null)`, has
    `localOnly` and `secretFirstArg`, mirroring `setVapidKeys`. It stores the
    token through the host's `SecretBox`.
  - On the desktop, `hosts.setLinearOnHost(hostId, on)` (local-only) is shown
    as a **"Use Linear on \<host\>"** toggle in `HostPhoneAccess` settings.
    The desktop's own Linear token is sent; Linear has no narrower token type
    to send instead.
  - Turning it off, or **Reset pairing keys** (`hostServer.resetIdentity`),
    deletes the copy.
  - `linear.*` on the host table answers `unavailable:host` with "Linear isn't
    turned on for \<host\>" until the token is there.
  - Linear calls for a remote host's projects on the desktop **stay on the
    desktop**. The token is already there, and Linear isn't tied to a path.
- **Image proxy.** Both trackers' image proxies are Node-only, so they come
  along with their managers.
- **The Linear MCP alternative is documented only** (ADR-225 asked slice 2 to
  decide). It needs nothing from Manor, and supporting it as a third path
  would mean a launch mode that skips Manor's own issue link.

### D8. The box's `manor` CLI is answered by the host server

The daemon's control relay (ADR-189) currently forwards every CLI request on
a remote host to the desktop. After the flip, the desktop would only proxy
most of them back to the host. Instead:

- **The host server registers as the control-relay answerer** for its
  daemon. It answers routes over `ServerDeps`: projects, workspaces, folders,
  agents (list, launch), issues and `current-workspace`. These routes run
  through `createManorServer`, so they are the same code.
- **Routes that need the desktop** answer "needs Manor desktop", the same
  wording as today's message for an absent desktop. These are webview,
  panes, browser and system. The CLI's own help already says they aren't
  available from remote hosts.
- **The caller-scoping rule** (`callerMaySee`, `electron/routes/caller-host.ts`)
  still applies. To the host, every caller is local.

## Consequences

**Better**
- **The end state works from the phone with the lid closed.** It can browse
  issues, create a worktree, launch an agent, follow it, and see its PR
  (ADR-225 end-state steps 2–6). Step 1 (one sidebar for every host) is
  slice 3.
- **One server composition.** A feature added to `createManorServer` works
  on the desktop and on every host, unless a platform port is missing.
- **No journal replay or manifest drift on the desktop.** A project set up
  on the box while the desktop slept is simply there.
- **Launches no longer need a renderer.** That also fixes the desktop's
  quieter version of the bug: a setup script for a workspace created by the
  CLI while no window was open.
- **`manor` on a remote host works without the desktop.**

**Harder**
- **The flip is one-way per host.** After adoption, the box is the source of
  truth. Losing the box loses its projects' Manor metadata (worktrees and
  branches are in git anyway). The pre-adoption backup covers a rollback.
- **The desktop depends on a running host server** for any remote state. A
  box whose host server can't start (for example, too old a Node) shows the
  host as broken, not degraded. Slice 1 could still fall back to the daemon.
- **Routing adds a layer.** Every shared method that touches host state needs
  the right `route`. A missing route silently handles the call locally. A
  surface test lists each routed namespace and fails on any method in it
  with no route.
- **Two hops for remote writes** (renderer → desktop → host). Slice 3 removes
  the middle hop.
- **GitHub for remote projects needs `gh` on the box.** It didn't before.

**Risks**
- **Adoption bugs lose user metadata:** workspace names, folders, linked
  issues. Mitigations: the backup file, ack-before-delete, merge-not-overwrite,
  and an E2E that adopts a seeded `projects.json` and compares.
- **Server-side spawn changes launch timing on the desktop.** A pane
  mounting after spawn sees output it didn't watch start. The snapshot on
  attach covers this, as it does for reattach today.
- **The size of the change.** This is the biggest slice. The tickets order
  it so that the refactors (1–4) land with no change in behavior, before the
  flip (5–9).

**Known limits as built**
- **Legacy boxes regress.** A box with no current host server (it failed to
  start, or its upgrade failed) gets no agent status, chat or worktree polling
  on the desktop, and no last-known workspaces while away. `removeProject` for
  such a project while its host is away only tears down the main path's
  layout. This follows from the D4 deletions; the fix is to upgrade the box,
  which the next connect does.
- **An old host server without `hostServer.control`** answers the desktop's
  MCP/CLI writes for its projects with 503/502 until the box is upgraded.
  `enableControlRelay`'s optional `role: "server"` is backward-compatible
  (wire hash re-recorded, protocol stays 6).
- **Moving a project off an adopted host ends its panes there**, because the
  host's `projects.remove` tears down its layout. The layouts themselves are
  taken to the desktop first and move with the project. `hostPaths` (the remembered
  path) is lost after adoption. A transfer onto an adopted host doesn't carry
  the source's main-workspace name and issues.
- **Detached-window viewport claims** for a remote workspace are lost: a host
  has no windows, so a forwarded `reportViewport` goes nowhere.
- **A remote pane's first mount costs one extra round trip** (the host's
  `pty.create` before the daemon attach). Deliberate: it is how the host
  delivers a pending command, such as a resume, into a session it lost.
  A re-mount of a session the desktop attached and has not seen exit skips
  it.
- **`github.proxyImage`, `createIssue` and `listRepos` stay on the laptop's
  `gh`.** A private-repo image in a remote project's PR uses the laptop's
  sign-in. The GitHub nudge and settings section check `gh` on the laptop only.
- **Stats-only reads** (kill counters, busy-agent count) ignore remote agents.
- **`callerHostId` / `callerMaySee` are never set any more.** Every CLI caller
  on the box is local to its host server; the scoping branches are dead but kept.
- **E2E gaps:** no test for the "Use Linear on \<host\>" toggle (no Linear
  stub) or the "gh isn't signed in" empty state. Known Linux e2e failures that
  also fail on main are listed in `docs/remote-hosts.md#testing`; remote-host
  "laptop closed … one notification", which fails on main, passes here (it
  flaked once in three full runs during integration).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
