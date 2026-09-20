# Manor

A desktop app for running and steering coding agents across projects and
workspaces. This glossary exists because the same machine can now be reached
three ways — the Electron window, a phone, and a browser — and each one has a
different name and a different amount of power.

## Language

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

**Default viewport**:
The host's per-workspace memory of the last viewport any renderer reported, used only to open a fresh renderer somewhere sensible; overwritten freely, never pushed to a renderer that already has one.
_Avoid_: last focus, shared focus

**Follower**:
A viewer that renders the winsize owner's grid as-is — shrinking the font to a floor, then panning — and never calls resize.
_Avoid_: mirror, read-only viewer (a follower may still type)

## Relationships

- A session has exactly one **Winsize owner** and any number of **Followers**; the remote client is always a **Follower**.
- A **Host** is one **Manor server** plus one **Daemon**; the **Manor server** owns the layout, every **Renderer** holds a replica and sends commands.
- Layout *structure* (panels, tabs, pane trees) is shared across all renderers of a host; *viewport* (which panel, tab and pane each one is looking at) is per renderer.

- The **Desktop app** issues tokens; a **Paired device** holds exactly one.
- The **Web app** and the **Remote client** are both served to a **Paired device**, over the same tunnel.
- A **Remote client** reaches a narrow **Remote surface**; a **Web app** reaches the full one.
- A **Paired device**'s **Capability** decides its **Remote surface**: `read` and `send` are filtered by the allowlist; `full` is the unfiltered table.

## Example dialogue

> **Dev:** "Should the mobile app get the git panel?"
> **Domain expert:** "There is no mobile app. The **web app** is the desktop app in a browser, so it already has the git panel — the question is whether it lays out on a phone. The **remote client** never gets it; that page exists to tap `y` over a bad connection."

## Flagged ambiguities

- "mobile/web experience" was used to mean a new client; resolved: it is the **Web app**, one responsive codebase, not a second client.
- "remote" is overloaded across ADRs: ADR-160 *remote workspace backends* means a workspace living on another machine; ADR-161 *remote control* means a **Paired device** reaching this one. Prefer **paired device** / **remote surface** for the latter.
