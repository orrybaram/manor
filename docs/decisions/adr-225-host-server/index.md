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

# ADR-225: A Manor server on every host

## Context

Agents on a remote host already keep running when the laptop closes: the
daemon outlives the SSH connection, and the hook journal (ADR-178 §2) records
every status change so the desktop can replay it later. What stops working is
**seeing and steering them**. The phone reaches agents through the relay room
of the *desktop* (ADR-206), and the desktop's Electron main is the only Manor
server in the system. Closed lid, no server, nothing for the phone to join.

ADR-178 (web app) already named the end state. D4: *a host is one Manor server
plus one Daemon … hosted in Electron main today, headless in the cloud later*.
D7: *the cloud host runs a Manor server and a daemon; the renderer attaches to
it exactly as it attaches to the local host*. This ADR starts building that.

### What two competitors did

Both ended up with the same design on their own, and both had to migrate to
get there:

- **Superset** runs the same `host-service` (Node, its own SQLite) plus a
  separate `pty-daemon` on every host: the laptop, SSH boxes and cloud sandboxes
  alike. Projects and workspaces moved *out* of their cloud DB into each
  host's DB ("v2 goes fully local"). Clients ask each host for its list.
- **Orca** had manor's exact setup until v1.4.225: a thin relay on the SSH
  box holding PTYs, with the server on the laptop. It replaced that with
  `orcad`, the full headless runtime that `orca serve` runs, and wrote a
  converter to move state onto the box.

Neither keeps the laptop's *own* agents reachable while it sleeps. Their
answer is always "run them on a host that is awake". Ours will be too.

### What the code gives us

- **The daemon is already headless** and already lives apart from the server
  (`electron/terminal-host/`). The server restarting does not end sessions.
  This is the same split Superset makes between `pty-daemon` and
  `host-service`.
- **The bridge protocol is transport-agnostic** (`electron/bridge/types.ts`
  has no imports). `BridgeServer` takes an injectable handler table, and
  `WsBridgeServer.attach(FrameSocket, …)` accepts any socket.
- **The relay supports any number of servers already.** A room is addressed
  by the hash of an Ed25519 key (`relay/src/index.ts:146`). A second identity
  is a second room, with no relay change.
- **The web app is served by the relay Worker**, not by Manor
  (`relay/src/index.ts:84-131`), so a headless server never serves assets.
- **The host tarball already refuses `require("electron")`**
  (`scripts/build-host-tarball.mjs:58-66`).
- **What is in the way:**
  - The server is one 900-line function, `initApp()` in
    `electron/app-lifecycle.ts`, with no reusable server object.
  - `HostDeps` carries `BrowserWindow`.
  - Secrets go through `safeStorage` in `devices.ts`, `push.ts`,
    `relay/identity.ts` and `linear.ts`.

## Decision

### D1. The host server: a headless Manor server on each remote host

`manor-host serve` runs a **host server** on a remote host: Node, no Electron.
It runs next to the daemon, as a separate process. It connects to the daemon as
an ordinary stream client over the local socket (namespace `remote`), the same
way the desktop does over SSH.

- **Why a separate process from the daemon.** A daemon protocol bump restarts
  the daemon and ends sessions (ADR-185). The server has to stay free to
  upgrade on every release, so it gets its own process. It does not run inside
  `manor-host`.
- **State** lives in `~/.manor/remote/server/`, not in `manorDataDir()`. A box
  that also runs desktop Manor (WSL, a Mac mini) keeps the two apart.
- **Composition.** A new `electron/host-server/` composes the server from
  existing parts. It does **not** extract `initApp()`; slice 2 does that, once
  two compositions show what really overlaps. The parts:
  - `TerminalHostClient`
  - the agent status driver and reconciler
  - `AgentManager` (agents.json)
  - `ChatMirror` with the local transcript source (transcripts are files on
    this box)
  - `BridgeServer` with a host handler table
  - `RemoteDeviceStore`, `PushManager`, `RelayIdentityStore`, `RelayConnector`
    and `RelayGate`

  Where a part takes an Electron object, it gets a port (D6). It does not get
  an `if (headless)` branch.
- **Lifecycle** matches the daemon. `manor-host remote-bridge` calls
  `ensureRunning()` for the server as well as the daemon (detached, unref'd).
  When the server's version does not match the tarball, the server restarts
  and the daemon does not. Surviving a reboot is out of scope here, because the
  daemon does not survive one either.

### D2. Ownership: two readers of one journal in slice 1, the host owns it all in slice 2

The end state is the one Superset and Orca reached. **The host server is the
authority for everything on its host**: projects checked out there,
workspaces, agents, status, transcripts. The desktop becomes one client of it,
and the phone another.

Getting there flips ownership of most of what `projects.json` and `agents.json`
hold today. That needs a migration, and the desktop's remote backend has to move
from talking to the daemon to talking to the host server. That is slice 2.
**Slice 1 is a tracer bullet that needs no ownership flip:**

| State | Slice 1 owner | How the host server gets it |
|---|---|---|
| Agent status, agents on this host | **Both**, deterministically | Each one replays the same hook journal through the same reconciler. The desktop by `replayHooks` as today; the host server live from the daemon's `hookEvent` stream plus `replayHooks` at start. Same input, same pure reducer, same result. |
| Transcripts (chat mirror) | Host server | Local files |
| Projects on this host, workspace names and issues | Desktop | **Manifest** pushed over the owner channel (D4) on connect and on change, then cached on the box |
| Workspaces (worktrees) | Git on the box | `git worktree list` for each manifest project |
| Layout | Desktop | A **layout snapshot** pushed with the manifest, filtered to this host's workspace keys (D5) |
| Phone pairings, push subscriptions, relay identity | Host server | Its own stores (D3) |

Rejected: **the desktop stays the only server and keeps a cloud relay to the
box** (ADR-178 D7's "state in the cloud, sessions local" in a different form).
It keeps the one machine that must be awake. Also rejected: **flip ownership
in slice 1**. It is right, but it is the largest change in the plan, and it
should not block "phone sees agents with the lid closed".

### D3. Each host server has its own relay identity and room

The host server holds its own Ed25519/X25519 identity, so it gets its own room
on `relay.manor.sh`. Its connector dials out exactly as the desktop's does.
Devices are paired **per room**: a phone paired to the desktop and to `wsl-box`
holds two pairings. The relay does not change.

- **Pairing is minted by the host server** and shown by the desktop (D4).
  `remoteControl.pair` runs on the host server; the desktop renders the QR.
- **Capability is `full` only**, the same rule as ADR-206 relay pairing.
  `full` on a host server reaches only that host.
- **Push.** The host server holds its own subscriptions and sends pushes from
  its own notification coalescer, so a phone hears "requires input" from
  `wsl-box` with the lid closed.
  - **Every server signs pushes with the desktop's VAPID key.** The desktop
    sends it over the owner channel, and the host stores it through its
    `SecretBox`.
  - The reason: a browser's service worker holds one push subscription, tied
    to one VAPID key. If each server had its own key, every room switch would
    replace the subscription, and only the last-opened room would push.
  - With one shared key, the phone's single endpoint works for every paired
    server, and the dedupe below is by that endpoint.
  - A host that has never received the desktop's key uses its own until it
    does.
- **No duplicate pushes.** The desktop also sees those agents. It suppresses
  its own push for an agent on host H to any push endpoint that H's server
  also holds. The desktop learns those endpoints over the owner channel.

### D4. The owner channel: the desktop is a bridge client, authenticated by SSH

The desktop talks to the host server over the **same bridge protocol** the
phone uses, carried on a second stream of the host's existing `HostTransport`:
`ssh -T <target> 'exec manor-host server-bridge'`.

- **How the stream reaches the server.** `server-bridge` reads a 0600 token
  file on the box, writes a `hello`, and then pipes stdio to the server's unix
  socket. This mirrors `remote-bridge` (`electron/terminal-host/bridge.ts`).
  SSH is the authentication: whoever can run a command as that user is the
  owner.
- **A new caller class, `owner`.** Today `BridgeConnection.callerClass` is
  `desktop | device`. An owner may call `LOCAL_ONLY_METHODS` on the host
  server (pairing, device revoke), which a device may not.
- **New owner-only methods:**
  - `hostServer.syncManifest(manifest)`
  - `hostServer.syncLayout(snapshot)`
  - `hostServer.status()` (version, uptime, paired device count, push
    endpoints)
- **Desktop side.** A `HostServerClient` per remote host, owned by the backend
  registry next to `RemoteBackend`. It reconnects on the host's reconnect
  events and re-sends the manifest and layout after each connect.

Rejected: relaying through the daemon's control relay (ADR-189). That path
exists for a CLI's HTTP requests and is shaped like them. The owner channel is
the protocol that slice 2's desktop will speak to every host anyway.

### D5. What a phone on a host server can do in slice 1

**Can:**
- See the host's projects, workspaces and agents with live status.
- Open any session's terminal and type into it (follower rule below).
- Use the chat view and reply (ADR-215–217), including slash commands.
- Get push notifications.
- Switch between paired hosts (D7).

**Cannot yet** (each refusal shows a named state, not an error; these come in
slice 2):
- Create a workspace or launch an agent.
- Rearrange the layout.

The reason: in slice 1 the desktop owns projects and layout, and a mutation made
on the box while the desktop is away has nowhere to be reconciled.

**Layout.** The phone walks the last snapshot the desktop pushed (ADR-181).
`<hostId>:<path>` workspace keys are rewritten to bare paths, because to the
host server its own host is local. A daemon session missing from the snapshot
(started after the last push) is appended under a synthetic **"Started while
away"** tab. `layout.save` from a device is refused, like ADR-178 slice 1.

**Winsize.** ADR-178 D5 said the "is a desktop attached?" check would move into
the daemon when a host had no Electron main to ask. This is that host. The
daemon adds `attachedClients` to its session info. A host-server viewer is a
**follower** whenever any other client is attached to the session, and the
owner otherwise.

### D6. Ports for the four Electron dependencies the host server meets

- **`SecretBox`** (`electron/platform/secret-box.ts`): `encrypt` and `decrypt`
  over `Buffer`, plus `available()` and `backend()`.
  - The Electron version wraps `safeStorage` and behaves exactly as today.
  - The host version uses the first of these backends that works:
    1. **`systemd-creds --user`** (systemd 256+). Encrypts with a key derived
       from the machine's own credential secret, using the TPM2 when there is
       one. The user can decrypt without root, but a copy of the file is
       useless off the box. This closes the leak 0600 alone leaves open:
       backups, disk images, volume snapshots.
    2. **libsecret**, when an unlocked keyring is reachable over D-Bus.
    3. **Plaintext 0600 files** as a last resort. Never silent:
       `hostServer.status()` reports the backend, and the desktop shows
       "Pairing keys on \<host\> are stored unencrypted".
  - Hosts we start ourselves (slice 4) take secrets from a mounted Secret or an
    environment variable, never from the persistent volume.
  - **What the box holds.** The relay identity private keys and the VAPID
    private key. Device tokens are stored only as SHA-256 hashes
    (`devices.ts`). Integration tokens stay on the desktop unless the user opts
    a host in (D8).
  - **Rejected:** the desktop handing over an unlock key that the server keeps
    only in memory. A server restarted while the lid is closed could not unlock
    its keys, which defeats the point of this ADR.
  - **Reset pairing keys** (desktop, per host) generates a new relay identity.
    That moves the host to a new room and revokes every phone paired with it.
    This is the recovery step if a box is ever compromised.
  - `devices.ts`, `push.ts`, `relay/identity.ts` and `linear.ts` take a
    `SecretBox` instead of importing `safeStorage`.
- **`Notifier`:** desktop notifications on Electron. On the host server it does
  nothing; push is the host's only notification channel.
- **`AppInfo`:** version, packaged flag, and the logs directory.
- **`openExternal`:** absent on the host server. Handlers that need it are
  left out of the host handler table.

The host handler table is an explicit allowlist in
`electron/host-server/handlers.ts`, in the style of `allowlist.ts`. A
namespace that is not listed answers `unavailable:host`, and the renderer
already degrades `unavailable:*` to stated empty states.

### D7. The phone holds several pairings

The web app stores pairings keyed by room. With more than one, the top bar
shows a **host switcher** ("This Mac", "wsl-box"), and each host is one bridge
connection. Showing every host's agents together in one sidebar waits for
slice 3.

### D8. Integrations run where their credential already lives

Today every integration runs on the desktop, including for remote projects:
- `github.ts` runs the laptop's `gh` with `-R owner/repo`, with the repo
  resolved from the remote checkout.
- `linear.ts` calls the API with a token kept in the desktop's `safeStorage`.
- The image proxy sends a tracker's token only to that tracker's own hosts
  (commit aa011279).

Agents on the box keep using the box's own `gh` and git credentials, as they
do today. Nothing in this ADR touches that.

Every integration, now and in future, is one of two classes:

- **Host-native.** The credential already exists on the box because agents need
  it: `gh` and git. The host server may run these with the box's own auth, and
  nothing gets copied. If `gh` is not signed in there, the feature shows "gh
  isn't signed in on \<host\>" instead of an error.
- **User-delegated.** A credential the user granted to Manor itself, such as
  Linear's API key or a future OAuth app. It stays on the desktop. Copying it
  to a host is an explicit, per-host opt-in ("Use Linear on wsl-box"). The copy
  is stored through the host's `SecretBox`, and a narrower token is used where
  the provider offers one. Removing the opt-in, or **Reset pairing keys**,
  deletes it.

A new integration says which class it is when it is added, and the host handler
table allows only host-native ones unless the host has opted in.

**In slice 1** the host server makes **no integration calls**. The manifest
(D4) carries the last-known display data the desktop already has, stamped with
when it was taken, so the phone's sidebar doesn't go blank with the lid closed:
- each workspace's linked issue (id, title, URL);
- its PR (number, state, checks).

Browsing issues, starting work from an issue, and issue images answer
`unavailable:host`. Host-native GitHub calls and the Linear opt-in arrive in
slice 2, when the phone can create workspaces and needs them.

Rejected: a Manor cloud backend that holds integration tokens for every host
(Superset's model). Manor has no accounts and no backend that holds user data,
and this ADR doesn't add one.

### End state: starting a Linear task from the phone

This is the target slices 2 and 3 build toward, written down so that each one
can be checked against it. The laptop is closed, and an agent on `wsl-box`
should pick up ENG-412.

1. **The phone opens** one sidebar covering every paired host (slice 3).
2. **The phone browses issues.** `wsl-box`'s host server queries Linear with
   its own copy of the token. It has one because the user turned on "Use Linear
   on wsl-box" from the desktop (D8, slice 2).
3. **Start on wsl-box.** The host server owns the host's projects (slice 2), so
   it does the whole start on its own, with nothing left for the desktop to
   reconcile later:
   - creates the worktree;
   - links ENG-412 to it;
   - builds the prompt from the issue;
   - launches the agent on its own daemon.
4. **The phone follows** through push, the terminal and the chat view.
5. **The agent opens the PR** with the box's own `gh` sign-in, as agents do
   today. The host server reads the PR's status the same way, because GitHub is
   host-native.
6. **The laptop opens** and connects to `wsl-box` as a client (slice 2). The
   workspace, agent and PR are already there.

What it depends on:

| | Linear on for wsl-box | Linear not on |
|---|---|---|
| Laptop closed | Works as above | Agents and terminals work; Linear browse and start are unavailable on that host, with that reason stated |
| Laptop awake | Works | Slice 3 routes the Linear call through the desktop's server, which the phone is also connected to. The token never leaves the desktop. |

**Lighter alternative** for a user who won't put the token on a box: a Linear
MCP server set up for the agent on the box. The phone sends only the issue id,
and the agent fetches the issue itself. That covers starting a task with the lid
closed, but not browsing issues on the phone. Slice 2 decides whether Manor
supports this as a third path or only documents it.

### Slices after this one (each its own ADR)

1. **Slice 2: ownership flip.**
   - The host server becomes the authority for its projects, workspaces,
     agents and layout.
   - The desktop's remote path moves from talking to the daemon to talking to
     the host server.
   - `projects.json` and `agents.json` entries for that host migrate onto the
     box, like Orca's runtime conversion.
   - Desktop journal replay is deleted.
   - The phone can launch agents and create workspaces.
   - Host-native GitHub calls run on the host server, and "Use Linear on
     \<host\>" ships (D8). This covers end-state steps 2 to 6.
   - `initApp()` is split into a shared `createManorServer(platform)`.
2. **Slice 3: one renderer, many servers.** The renderer holds a bridge per
   host and the sidebar merges them. The phone sees every paired host in one
   list. A user-delegated integration call for a host that hasn't opted in is
   routed to the desktop's server while the desktop is awake.
3. **Slice 4: hosts we start ourselves.**
   - Pods, sandboxes and VMs through `HostProvider` with ADR-178 §1's
     `ensureUp`, `status` and `setBusy`.
   - Or an Orca-style recipe that provisions anything and returns SSH details.
   - Each one runs the same tarball, so it brings a host server with it.
   - Supervision that survives a reboot (systemd user unit, LaunchAgent) lands
     here.

## Consequences

**Better**
- Close the laptop, and the phone still sees and steers every agent on a
  remote host, including push for "needs input". This is what the
  competitors call "keeps running when your laptop sleeps", and it is true
  here for the same reason: the agents run on a host that is awake.
- The pieces slice 1 adds are the ones the later slices keep:
  - the headless composition
  - ports in place of Electron imports
  - one identity per host
  - the desktop as an SSH-authenticated bridge client
  - a winsize owner the daemon can decide
- Kubernetes and cloud hosts (slice 4) become "run the tarball somewhere". The
  host server travels with it.

**Harder**
- **Two compositions of the server** (`initApp` and `createHostServer`) until
  slice 2 merges them. A new feature that should work on the phone with the
  lid closed has to be added to the host handler table on purpose.
- **Two readers of one journal.** They agree only while the reconciler stays a
  pure function of the journal. A side effect slipped into the reconciler
  would split them. A test pins it: replay one journal into both and compare.
- **Secrets on the box depend on the box.** They are encrypted when systemd
  256+ or a keyring is present, and plaintext 0600 otherwise, with a visible
  warning. Either way, someone who is already your user on the box can use
  them. That person can also reach the terminals, the repos, and Claude's own
  credentials, so the keys add little. What encryption fixes is the files
  leaving the box.
- **Integrations are partly dark with the lid closed.** In slice 1, issue and
  PR data on the phone is a timestamped snapshot, and live calls wait for
  slice 2.
- **More pairings to manage.** One QR per host until slice 3.
- **The tarball grows.** The relay connector uses the `ws` package (for
  `maxPayload`, handshake timeouts and `terminate()`), and push uses
  `web-push`. Both ship in the host tarball.

**Risks**
- The read-only intermediate state (no launching from the phone) will be
  reported as a bug. Each refusal names it.
- Manifest drift: a project set up on the box while the desktop was away is
  invisible to the phone until the desktop next connects. Slice 2 removes
  this.
- Relay cost grows with hosts × devices. The per-room daily byte budget (ADR-206
  D1) still caps each room.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
