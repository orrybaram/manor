# Manor

A desktop workspace manager for running coding agents (Claude, Codex, pi, opencode)
in terminal panes across local and remote hosts. This glossary also exists because the
same machine can now be reached three ways — the Electron window, a phone, and a
browser — and each one has a different name and a different amount of power.

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
responded, error, idle), decided only by the **Status reconciler**. A finished turn is
**responded**; an ended session is **idle** (its **Agent** lifecycle becomes `completed`).
_Avoid_: dot state, detector status, live status, "complete" (removed — use responded, or the lifecycle)

**Status signal**:
A single piece of evidence about an **Agent**'s state: a hook event, a daemon
report of the foreground process, terminal title or output pattern, or a **tick**
(the current time, which is how every time-based rule — stuck-working, orphan and
held-Stop recovery — reaches the **Status reconciler**).
_Avoid_: fallback status, hint

**Pane facts**:
The daemon's latest snapshot of what it can see in a pane: foreground process (and its
**Agent kind**, if known), last terminal title, and last output hint with its time. Sent on
change and on request; a source of **Status signals**, never an **Agent status**.
_Avoid_: detector state, agent state

**Hook-driven**:
An **Agent** whose root session has sent at least one hook signal; from then until the session
ends, only hook signals decide its turn statuses.
_Avoid_: "has hooks", "hook-capable" (support is observed, not declared)

**Status reconciler**:
The one module, in Electron main, that turns **Status signals** for a pane into its
**Agent status** and the reason for it.
_Avoid_: detector, relay (those become signal sources/effects, not deciders)

### Reaching the machine

**Desktop app**:
The Electron window; the reference experience every other surface mirrors.
_Avoid_: native app, main app

**Web app**:
The desktop app's own renderer, served to a browser and made responsive; one
codebase, full functionality, authentication is its only boundary.
_Avoid_: mobile app, mobile client, mobile/web experience, responsive client

**Paired device**:
A phone or browser that holds a per-device token issued by the desktop app.
_Avoid_: remote, client device, session

**Relay**:
The hosted blind pipe (`relay/`, a Cloudflare Worker) that a desktop and a phone both dial out to, so a device can reach the machine with nothing installed. It forwards Noise ciphertext between a **Room**'s host and its **Channels** and cannot read any of it; it also serves the web app, one build per version.
_Avoid_: server, proxy, tunnel, listener (nothing on the machine listens for remote control; the desktop dials out to the relay, which feeds the bridge directly)

**Room**:
One desktop's place on the **Relay**, addressed by the hash of its relay public key and held by whoever holds the key. At most one host and a few **Channels**.
_Avoid_: session (that is a terminal session), channel

**Channel**:
One viewer's encrypted stream inside a **Room** — its own Noise session, ending in the bridge's `hello`.
_Avoid_: connection, socket (and not the `bridge:*` IPC channel name)

### Where things run

**Renderer**:
The React client — the same code whether it runs in the Electron window or a browser — which holds no authoritative state and reaches everything through the bridge.
_Avoid_: frontend, UI, the app

**Manor server**:
Everything in `electron/` that is not Electron: projects, routes, integrations, notifications, remote control, and the layout authority; hosted inside Electron main today, headless in the cloud later.
_Avoid_: main process, backend, the API

**Daemon**:
`terminal-host/` — the process that owns PTYs, scrollback, and agent detection; already headless, already runs wherever a host is.
_Avoid_: terminal host, pty server

**Host**:
A place sessions run — the local machine, or a cloud box — always a Manor server and a daemon together; the renderer attaches to exactly one at a time, and local stays a first-class choice.
_Avoid_: backend, cloud, remote (see ADR-160, which introduced the term)

**Bridge**:
The one interface the renderer uses to reach a host: one host surface, reached over two transports — Electron IPC inside the desktop, a WebSocket from a browser — never two implementations converging on one (ADR-180).
_Avoid_: preload, window.electron, API client

**Host surface**:
The handler table (`electron/bridge/handlers.ts`): the one set of things a renderer can ask a host to do, keyed `ns.method`. A type-level check asserts every method the renderer can call is placed somewhere — the table, a native preload namespace, or answered in the tab — so an unplaced method is a compile error, not a runtime `unavailable:web`.
_Avoid_: API, route table (that name is `electron/routes/`, a separate caller of the same managers)

**Transport**:
How a frame reaches the host surface — Electron IPC or a WebSocket today. Never a place where behaviour lives; a third transport is a new file in `src/bridge/transports/`, not a new decision.
_Avoid_: connection (a transport makes connections; it is not one), channel (channel is the specific `bridge:*` IPC name)

**Caller class**:
What a connection is, as far as the bridge's dispatch is concerned: `local` (an Electron renderer window, authenticated by being one) or `device` (a paired device, authenticated by its token). Decides which host-surface methods a `LOCAL_ONLY` entry refuses.
_Avoid_: tier (there is one kind of paired device; what it may not call is `LOCAL_ONLY`, decided per method)

### Viewing a session

**Viewer**:
Any client attached to a session's output stream — a desktop pane or a web-app pane.
_Avoid_: client, subscriber, socket

**Winsize owner**:
The one viewer whose grid the PTY winsize follows: the desktop app while it has the pane mounted, otherwise the most recent web-app viewer.
_Avoid_: primary, master, resize authority

**Layout command**:
A named, argument-carrying request to change layout structure — split, close, move, new tab, pin — sent by any renderer or the MCP/CLI to the Manor server, which alone runs the reducer and broadcasts the result.
_Avoid_: action (the zustand word), mutation, app-command (the ADR-156-era server→renderer channel, which is only for viewport now)

**Viewport**:
What one renderer is currently looking at — active workspace, active panel, selected tab per panel, focused pane per tab — persisted per renderer (the desktop in its own file, a browser in its storage), never authoritative on the host.
_Avoid_: view state, UI state, selection

**Claim**:
A desktop window's exclusive hold on one tab of a workspace, reported as viewport, so a detached window shows it and the primary hides it; released when the window closes, never held by a browser, never part of layout structure.
_Avoid_: detach payload, hand-off, ownership (that word is for winsize)

**Detached window**:
A desktop window whose viewport is a single claim; the same renderer as the primary, not a separate app.
_Avoid_: popup, secondary renderer, popout

**Layout mode**:
`phone` or `desk` — a presentation of the viewport, chosen by width alone
(`useLayoutMode()`, ~768 px) and never by platform: the desktop window dragged
narrow is `phone` too, and a **detached window** is always `desk` regardless
of its width, since it already shows one claim with no chrome (ADR-181 D2).
_Avoid_: mobile mode, responsive view, breakpoint (breakpoint is the number;
layout mode is the answer it produces)

**Default viewport**:
The host's per-workspace memory of the last viewport any renderer reported, used only to open a fresh renderer somewhere sensible; overwritten freely, never pushed to a renderer that already has one.
_Avoid_: last focus, shared focus

**Follower**:
A viewer that renders the winsize owner's grid as-is — shrinking the font to a floor, then panning — and never calls resize.
_Avoid_: mirror, read-only viewer (a follower may still type)

## Relationships

- A pane has at most one root **Agent** at a time; child sessions (subagents) belong to it.
- A child session's activity (thinking, working, or requires input — e.g. a subagent's permission
  prompt) may show as the pane's **Agent status** while the root's turn is in progress, but only the
  root's own signals can end a turn (**responded**, **error**, **idle**).
- The **Status reconciler** consumes many **Status signals** and emits one **Agent status** per pane.
- The daemon produces **Status signals**; it does not decide **Agent status**.
- Hook signals decide an **Agent**'s turn statuses. Daemon signals (foreground process, title,
  output patterns) decide only liveness (process gone → **idle**) — unless the **Agent** has no
  hook signals, in which case they decide everything.
- The **Status reconciler** is the only writer of an **Agent**'s lifecycle and last **Agent status**;
  the renderer displays what it publishes and does not re-derive it.

- A session has exactly one **Winsize owner** and any number of **Followers**; a web-app viewer is a **Follower** whenever the desktop has the pane mounted.
- A **Host** is one **Manor server** plus one **Daemon**; the **Manor server** owns the layout, every **Renderer** holds a replica and sends commands.
- Layout _structure_ (panels, tabs, pane trees) is shared across all renderers of a host; _viewport_ (which panel, tab and pane each one is looking at) is per renderer.

- The **Desktop app** issues tokens; a **Paired device** holds exactly one.
- The **Web app** is served to a **Paired device** by the **Relay** origin, and only there.
- A **Room** has one host and many **Channels**; each **Channel** is a **Transport** to the bridge, so every **Paired device** reaches the whole bridge, minus the `LOCAL_ONLY` methods.

## Example dialogue

> **Dev:** "The title says `✳ Done` but the dot still shows working — who's right?"
> **Domain expert:** "Neither on its own. The title is a **Status signal**; the **Status reconciler**
> weighs it against the last hook and decides the **Agent status**."

> **Dev:** "Should the mobile app get the git panel?"
> **Domain expert:** "There is no mobile app. The **web app** is the desktop app in a browser, so it already has the git panel — the question is whether it lays out on a phone. It reaches the same bridge as the desktop, so the question is the layout, not what the device is allowed to call."

## Flagged ambiguities

- "status" was used for both the persisted lifecycle (`active`/`completed`/`abandoned`/`error`)
  and the live **Agent status** — resolved: the persisted one is the **Agent**'s lifecycle,
  the live one is **Agent status**.

- "mobile/web experience" was used to mean a new client; resolved: it is the **Web app**, one responsive codebase, not a second client.
- "remote" is overloaded across ADRs: ADR-160 _remote workspace backends_ means a workspace living on another machine; ADR-161 _remote control_ means a **Paired device** reaching this one. Prefer **paired device** / **remote surface** for the latter.
