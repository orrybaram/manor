# Manor

A desktop workspace manager for running coding agents (Claude, Codex, pi, opencode)
in terminal panes across local and remote hosts.

## Language

### Agents

**Agent**:
One coding-agent session running in a terminal pane, persisted in `agents.json`.
_Avoid_: task (older name, still in some code), session (that is the hook-level id)

**Agent kind**:
Which agent CLI an **Agent** is: `claude`, `codex`, `pi` or `opencode`.
_Avoid_: harness, agent type

**Agent status**:
The one live state shown for an **Agent**'s pane (thinking, working, requires input,
responded, error, idle), decided only by the **Status reconciler**. Separate from the
**Agent**'s persisted lifecycle (`active`/`completed`/`abandoned`/`error`).
_Avoid_: dot state, detector status, live status, "complete" (use responded, or the lifecycle)

**Status signal**:
One piece of evidence about an **Agent**'s state: a hook event, the daemon's foreground
process, terminal title or output pattern, or a **tick** (the current time, which drives
every time-based rule).
_Avoid_: fallback status, hint

**Pane facts**:
The daemon's latest snapshot of a pane (foreground process, title, last output hint);
a source of **Status signals**, never an **Agent status**.
_Avoid_: detector state, agent state

**Status reconciler**:
The one module, in Electron main, that turns a pane's **Status signals** into its **Agent status**.
_Avoid_: detector, relay

### Reaching the machine

**Desktop app**:
The Electron window; the reference experience every other surface mirrors.
_Avoid_: native app, main app

**Web app**:
The desktop app's own renderer, served to a browser and made responsive; one codebase,
full functionality. There is no separate mobile app.
_Avoid_: mobile app, mobile client, mobile/web experience, responsive client

**Pairing ticket**:
The single-use, 10-minute secret a pairing link carries. The long-lived device token is
never in a link, QR code or reply.
_Avoid_: pairing token, invite code, pairing code

**Paired device**:
A phone or browser holding a per-device token for a **Room**. Pairing with the desktop
also pairs it with every host the desktop can reach.
_Avoid_: remote, client device, session

**Relay**:
The hosted blind pipe (`apps/relay/`, a Cloudflare Worker) that desktops and devices dial out
to; it forwards Noise ciphertext it cannot read and serves the web app.
_Avoid_: server, proxy, tunnel, listener (nothing on the machine listens; it dials out)

**Room**:
One Manor server's place on the **Relay**: one host and a few **Channels**.
_Avoid_: session, channel

**Channel**:
One viewer's encrypted stream inside a **Room**.
_Avoid_: connection, socket (and not the `bridge:*` IPC channel name)

### Where things run

**Renderer**:
The React client, the same code in the Electron window or a browser. Holds no
authoritative state; reaches everything through the **Bridge**.
_Avoid_: frontend, UI, the app

**Manor server**:
Everything in `apps/desktop/electron/` that is not Electron: projects, routes, integrations,
notifications, remote control, and the layout authority.
_Avoid_: main process, backend, the API

**Daemon**:
`apps/desktop/electron/terminal-host/`, the process that owns PTYs, scrollback and agent detection.
_Avoid_: terminal host, pty server

**Host**:
A place sessions run, the local machine or a remote box: always one **Manor server**
plus one **Daemon**.
_Avoid_: backend, cloud, remote

**Host server**:
The headless **Manor server** on a remote **Host** (`manor-host serve`,
`apps/desktop/electron/host-server/`). It is the authority for its host: projects, workspaces,
layout and agents.
_Avoid_: remote server, box server, cloud server, the daemon. "Remote" alone is
ambiguous: say **remote host** / **host server** for another machine, **paired device**
for a phone reaching this one.

**Owner channel**:
The desktop's own connection to a **Host server**, over SSH, as **Caller class** `owner`.
_Avoid_: control channel, sync channel, admin connection

**Adoption**:
The one-time hand-over of a desktop's records for a remote **Host** to its **Host server**.
_Avoid_: migration, sync, import

**Recipe**:
The user's own commands that start, stop and delete one remote **Host**, in
`~/.manor/host-recipes/<id>/`.
_Avoid_: environment, template (a template is what a recipe is made from), provisioner

**Host profile**:
A recipe template plus the answers every host made from it shares.
_Avoid_: preset, cluster config, environment

**Project's pod**:
A **Host** made for one project ("In a new pod"), marked by `forProject`.
_Avoid_: dedicated host, project host, workspace pod

**Supervisor**:
What keeps a **Host**'s **Daemon** and **Host server** running across a reboot
(systemd, launchd, or `manor-host supervise`).
_Avoid_: service, init, watchdog

**Asleep**:
A remote **Host** its provider reports as `sleeping`. Only an action that uses it wakes
it; reads never do.
_Avoid_: offline, stopped (in UI copy), suspended

**Project**:
A repo, set up on one or more **Hosts**, with at most one checkout per host.
_Avoid_ in UI copy: group, member, linked project

**Set up on** / **Remove from host**:
Adding a project's repo to a host (clone or adopt a checkout), and dropping a host's
checkout without deleting files. A "move" is both.
_Avoid_: copy to, move to, link, unlink, clone onto

**Bridge**:
The one interface a renderer uses to reach a Manor server, over any **Transport**;
renderer code calls `window.electronAPI`.
_Avoid_: preload, window.electron, API client

**Server set** / **Router** / **Source**:
The renderer's Manor servers (`apps/desktop/src/bridge/server-set.ts`), the `window.electronAPI` that
routes each call across them (`apps/desktop/src/bridge/router.ts`), and the server answering for a
remote host right now. A host's data never arrives through two sources at once.
_Avoid_: connections, bridges, proxy, dispatcher, upstream

**Host surface**:
The handler table (`apps/desktop/electron/bridge/handlers.ts`), keyed `ns.method`. An unplaced
method is a compile error.
_Avoid_: API, route table (that is `apps/desktop/electron/routes/`)

**Transport**:
How a frame reaches the host surface (IPC or WebSocket). Never where behaviour lives.
_Avoid_: connection, channel

**Caller class**:
`local` (an Electron window), `owner` (desktop over SSH) or `device` (a paired device).
`device` may not call `LOCAL_ONLY` methods.
_Avoid_: tier

### Viewing a session

**Winsize owner**:
The one viewer whose grid the PTY follows: the desktop while it has the pane mounted,
otherwise the most recent web-app viewer.
_Avoid_: primary, master, resize authority

**Follower**:
A viewer that renders the winsize owner's grid as-is and never resizes; it may still type.
_Avoid_: mirror, read-only viewer

**Layout command**:
A named request to change layout structure (split, close, move, new tab, pin); only the
Manor server runs the reducer.
_Avoid_: action (the zustand word), mutation, app-command

**Viewport**:
What one renderer is looking at (workspace, panel, tab, pane); per renderer, never
authoritative on the host.
_Avoid_: view state, UI state, selection

**Claim**:
A desktop window's exclusive hold on one tab; a **detached window** is a window whose
viewport is a single claim.
_Avoid_: detach payload, hand-off, ownership, popup, popout

**Layout mode**:
`phone` or `desk`, chosen by width alone (`useLayoutMode()`, ~768 px), never by platform;
a detached window is always `desk`.
_Avoid_: mobile mode, responsive view, breakpoint

**Toast**:
A short in-app notice, bottom-right, that goes on its own. Its **subject** (an agent, a
pane or a workspace) is what it is about: while the subject is on screen in any window
the toast never appears, and one already up leaves when the subject gets there.
_Avoid_: notification (the native banner and the bell's log), snackbar, alert

## Rules that span files

- Hook signals decide an **Agent**'s turn statuses once its root session has sent one.
  Daemon signals decide only liveness, unless the agent has never sent a hook signal.
- Child sessions (subagents) may show their activity as the pane's status, but only the
  root's own signals end a turn.
- The **Status reconciler** is the only writer of an agent's lifecycle and status; the
  renderer displays it and does not re-derive it.
- Layout structure is shared by every renderer of a host; viewport is per renderer.
- A remote host's **Host server** owns its state and is the only reader of its hook journal.
