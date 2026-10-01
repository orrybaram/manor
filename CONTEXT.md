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

**Remote client**:
The deliberately tiny phone page (`src/remote-client/`) for glancing at agents
and tapping a reply; kept alongside the web app, not replaced by it.
_Avoid_: phone client, mobile client, PWA

**Paired device**:
A phone or browser that holds a per-device token issued by the desktop app.
_Avoid_: remote, client device, session

**Remote surface**:
The set of routes a paired device can reach; anything not on it is absent from
the dispatch table, not rejected by a check.
_Avoid_: API, allowlist (the allowlist is the mechanism, the surface is the result)

**Capability**:
How much a paired device may do, chosen at pairing and fixed per token: `read`
(watch), `send` (reply, stop, launch), or `full` (everything the desktop app can).
_Avoid_: permission, role, access level, canSend (the old boolean)

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
The one interface the renderer uses to reach a host; implemented over IPC inside Electron today and over HTTP/WebSocket from a browser, converging on the latter.
_Avoid_: preload, window.electron, API client

### Viewing a session

**Viewer**:
Any client attached to a session's output stream — a desktop pane, a web-app pane, or the remote client.
_Avoid_: client, subscriber, socket

**Winsize owner**:
The one viewer whose grid the PTY winsize follows: the desktop app while it has the pane mounted, otherwise the most recent web-app viewer.
_Avoid_: primary, master, resize authority

**Viewport**:
What one renderer is currently looking at — the panel, tab and pane in view, drawer and sidebar state — never shared, never persisted by the host.
_Avoid_: view state, UI state, selection

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

- A session has exactly one **Winsize owner** and any number of **Followers**; the remote client is always a **Follower**.
- A **Host** is one **Manor server** plus one **Daemon**; the **Manor server** owns the layout, every **Renderer** holds a replica and sends commands.
- Layout *structure* (panels, tabs, pane trees) is shared across all renderers of a host; *viewport* (which pane a phone is showing, sidebar collapsed) is per renderer.

- The **Desktop app** issues tokens; a **Paired device** holds exactly one.
- The **Web app** and the **Remote client** are both served to a **Paired device**, over the same tunnel.
- A **Remote client** reaches a narrow **Remote surface**; a **Web app** reaches the full one.
- A **Paired device**'s **Capability** decides its **Remote surface**: `read` and `send` are filtered by the allowlist; `full` is the unfiltered table.

## Example dialogue

> **Dev:** "The title says `✳ Done` but the dot still shows working — who's right?"
> **Domain expert:** "Neither on its own. The title is a **Status signal**; the **Status reconciler**
> weighs it against the last hook and decides the **Agent status**."

> **Dev:** "Should the mobile app get the git panel?"
> **Domain expert:** "There is no mobile app. The **web app** is the desktop app in a browser, so it already has the git panel — the question is whether it lays out on a phone. The **remote client** never gets it; that page exists to tap `y` over a bad connection."

## Flagged ambiguities

- "status" was used for both the persisted lifecycle (`active`/`completed`/`abandoned`/`error`)
  and the live **Agent status** — resolved: the persisted one is the **Agent**'s lifecycle,
  the live one is **Agent status**.

- "mobile/web experience" was used to mean a new client; resolved: it is the **Web app**, one responsive codebase, not a second client.
- "remote" is overloaded across ADRs: ADR-160 *remote workspace backends* means a workspace living on another machine; ADR-161 *remote control* means a **Paired device** reaching this one. Prefer **paired device** / **remote surface** for the latter.
