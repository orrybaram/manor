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

# ADR-178: The desktop app in a browser, over one bridge

## Context

The ask: the mobile/web experience should closely mirror the desktop — all the
core functionality, feeling the same. Interviewed against the code and the
existing decisions (`CONTEXT.md` now records the vocabulary this produced), the
ask resolved into something more specific than "build a better phone client".

### What exists

Three ways to reach a Manor machine, with very different amounts of power:

| | Code | Surface |
| --- | --- | --- |
| Desktop app | React, `src/`, 118 `.tsx` files | everything — 219 preload methods across 27 namespaces |
| Remote client (ADR-161/177) | vanilla TS, `src/remote-client/main.ts`, 16 KB | 7 allowlisted routes + 3 listener-own |
| Local control server | — | ~100 routes in `electron/routes/`, loopback, no auth |

The remote client is small on purpose. `docs/remote-control.md` does not say
the rest is unbuilt; it says the rest is **absent** from the table the listener
dispatches against, "so no mistake in an authentication check can reach them",
and `allowlist.test.ts` asserts whole families stay off. ADR-177 widened that by
one route and wrote three paragraphs to justify it. "All of the core
functionality" is not a widening of that file; it is a different surface.

### Three facts that decide the shape

1. **The renderer is already a browser app.** It is Vite + React + DOM; the
   only Electron in it is `window.electronAPI`, one global that 66 files call
   into. `vite.remote.config.ts` already proves a second browser target builds.
2. **The daemon is already headless.** `electron/terminal-host/` has zero
   imports from `"electron"`. PTYs, scrollback, agent detection and the layout
   file are already out of process; the renderer reaches them through IPC to
   main, main to a socket. Of `electron/`'s 126 non-test files, only 39 import
   Electron at all.
3. **The roadmap is a cloud host, optionally.** Sessions running on a cloud
   box, with the laptop and phone both viewers — ADR-160's `HostTransport`
   is the local prototype of that, still `proposed`. Any design in which the
   desktop *renderer* is an authority is work the cloud version throws away.

### Two problems the code does not answer today

**Winsize.** `terminal-host/session.ts` holds one `cols×rows` per session and a
`Set` of attached clients; any of them may `resize()`, last caller wins.
ADR-163/164/165 are three records about the single bug that appears when a
viewer's grid disagrees with the PTY winsize (Claude Code repaints
differentially against `process.stdout.columns`). Two xterm.js viewers of
different widths with fit-addon on would rebuild that bug as a feature.
ADR-177 already met this for the remote client and chose never to resize.

**Layout.** Panels → tabs → pane trees live in `app-store.ts` (3.3k lines) and
are written to `~/.manor/layout.json` on a debounce. The renderer is the
authority; `terminal-host/layout-persistence.ts` duplicates the `PaneNode` type
because it cannot import it. Two renderers means two authorities and
last-write-wins on one file. Detached windows (ADR-156) sidestep this with a
one-shot hand-off, not a sync.

## Decision

Ten decisions, in the order they were made. D1–D9 are direction; D10 scopes
what this ADR's tickets build.

**D1 — The web app is the desktop renderer, served to a browser and made
responsive.** Not a second client. `src/` is built a second time as a browser
bundle; on a PC it is the desktop app in a tab, on a phone it is the same
state at a phone layout (D9).

**D2 — The remote client stays.** 16 KB over a bad tunnel, and the only thing
that works when you want to tap `y`. It keeps its narrow, allowlisted surface
unchanged.

**D3 — A third capability tier, on the existing device model.**
`canSend: boolean` becomes `capability: "read" | "send" | "full"`. Same
listener, same pairing dialog, same tunnel, audit log and revoke list. For
`read` and `send` the allowlist applies exactly as today. For `full`,
authentication is the only boundary: the route table is the whole table. `full`
is never the default in the pairing UI, and its label says plainly that the
device can do anything the desktop can, including remove workspaces. Every
mutating request from a `full` device is audited (route key and target, no
bodies); none of them needs `confirmed: true` — the desktop UI's own
confirmation dialogs are in front of them.

**D4 — Three layers, named.** *Renderer* (React, pure client, no authoritative
state). *Manor server* (everything in `electron/` that is not Electron:
projects, routes, integrations, notifications, remote control — and, after D6,
layout; hosted in Electron main today, headless in the cloud later). *Daemon*
(`terminal-host/`, unchanged). A *host* is one Manor server plus one daemon;
local stays first-class.

**D5 — One winsize owner per session; everyone else follows.** The owner is
the desktop app while it has the pane mounted, otherwise the most recent web
viewer. A follower sets its xterm to the owner's `cols×rows`, never calls
resize, and scales its font down to a floor before panning — ADR-177's
`fitGrid` rule, generalized. Slice 1 places the "is a desktop viewer attached?"
check in main (which already handles every desktop `pty:create`); it moves into
the daemon when there is a host with no Electron main to ask. Accepted "for
now": per-viewer virtual grids (`@xterm/headless` per viewer) were rejected as
a distributed-terminal project of their own.

**D6 — Layout is owned by the Manor server (tmux model), shared structure, local
viewport.** Every renderer holds a replica and sends commands; the server
applies the same pure reducers (`pane-tree.ts`, `panel-tree.ts`, extracted to
a shared package) and broadcasts. Panels, tabs and pane trees are shared;
which pane a phone is *showing*, drawer and sidebar state are per renderer and
never persisted by the host. The IDE model (sessions shared, layout per device)
was rejected because "check on my agents from anywhere" means seeing the tabs
you left open, not arranging them again. **Not built in this ADR** — see D10.

**D7 — Sessions in the cloud, optionally.** The cloud host runs a Manor server
and a daemon; the renderer attaches to it exactly as it attaches to the local
host. "State in the cloud, sessions local" was rejected because it keeps the
worst part (a machine that must be on and tunnelled) and syncs only metadata.
Cloud authentication is **not decided here**; per-device tokens are the local
answer only.

**D8 — One transport, converging.** The bridge is one interface — the shape of
`window.electronAPI` — with two implementations: the existing preload IPC,
and a multiplexed WebSocket (request/response frames for what `invoke` did,
event frames for what `on` did plus the PTY stream). The desktop renderer
moves onto the WebSocket to its own local Manor server feature by feature, and
`preload.ts` shrinks to what only Electron can do (webview, native menu, dock
badge, open-in-editor, keychain, dialogs). The IPC path is a migration shim,
not a peer; no new preload method is added from here on. The renderer talks
to the **Manor server only**, never to the daemon: the daemon's token-file
auth was designed for a loopback caller, and one authenticated endpoint per
host is the number D3 settled on.

**D9 — On a phone, walk the shared layout one leaf at a time.** One
breakpoint (~768 px): above it the real grid; below it one pane full screen,
the owning panel's tab row as a top strip, the sidebar as a drawer, a pane
switcher as a bottom sheet, swipe between panes. Drag-to-split, drag-tab and
detach have no touch idiom and stay menu actions. The command palette is the
phone's keyboard: a persistent button opens it full screen. On a PC browser
the desktop keybindings stay, minus the chords the browser owns (`Cmd+W`,
`Cmd+T`, `Cmd+N`). **Not built in this ADR** — see D10.

**D10 — Ship a tracer bullet first; everything in it survives.** Slice 1, this
ADR: *a browser on a PC opens `/app`, pairs at `full`, shows the sidebar and a
live terminal for an existing session, and can type into it* — which forces
D3, the served bundle, the WebSocket bridge with reads + PTY proxy (D8's
boundary rule), and D5's follower mode, in miniature. Deliberately deferred to
follow-up ADRs, in order: **slice 2** the layout-ownership flip (D6); **slice
3** the desktop's convergence onto the WebSocket bridge and the deletion of
`electron/ipc/` (D8); **slice 4** the phone layout (D9). Between slice 1 and
slice 2 the web app is *read-and-type*, not *read-and-arrange*: you can watch
and drive any session from a browser; you cannot split, open tabs or start a
workspace from it yet. That is a named intermediate state, not a bug.

### What can never mirror in a browser

Named now so "all core functionality" is honest from day one:

| Feature | Why |
| --- | --- |
| Browser panes (ADR-052/056/058/158) | `<webview>` is Electron-only; a page cannot embed *and script* arbitrary cross-origin sites. Element picker, DOM read, screenshot and recording go with it. |
| Detach tab/pane to window (ADR-156/157) | `window.open` under popup blockers, no native chrome |
| Native app menu (ADR-170), dock badge (ADR-030) | no such API |
| Open in editor (ADR-050), keychain, path pickers | no filesystem or process access |

Each degrades to a stated empty state, never a crash or a silent no-op.

### Slice 1, concretely

- **Capability tiers** replace `canSend` end to end: `devices.ts` (with a
  migration of stored records), `verify()`, `allowlist.ts`'s `allowedKeys`,
  `server.ts`'s table build and `guardWrites`, the IPC/preload `pair` call,
  `RemoteControlPage.tsx`, `/me`. `allowlist.test.ts` gains "the full tier is
  the whole table" and keeps every family exclusion for `read` and `send`.
- **A web entry** `src/web-main.tsx` and `web.html`, built by
  `vite.web.config.ts` into `dist-electron/web/`, served by `static.ts` at
  `/app`. It reads the token from the URL fragment (as the remote client does),
  installs the WebSocket bridge as `window.electronAPI`, and renders the same
  `App`. No component changes to get pixels on screen.
- **A WebSocket endpoint** on the remote listener, `/ws`, opened only by a
  `full` device, authenticated by a first `hello` frame. Frames:
  `{id, kind:"invoke", ns, method, args}` → `{id, ok, result|error}` and
  `{kind:"event", ns, event, args}`. A handler table maps `ns.method` to
  main-process functions over `IpcDeps`; slice 1 implements the namespaces the
  sidebar and a terminal need (`pty`, `layout` reads, `projects` reads and
  selection, `preferences`, `theme`, `agents` reads, `keybindings`, `daemon`)
  and answers everything else with `unavailable:web`. PTY events are forwarded
  from `backend.pty.onEvent` for subscribed panes, the same hook
  `app-lifecycle.ts` uses for windows.
- **The bridge client** `src/web/ws-bridge.ts` implements the `ElectronAPI`
  type structurally via a `Proxy`: `ns.method(...)` invokes, `ns.onX(cb)`
  subscribes, and a namespace or method the server does not implement rejects
  with `BridgeUnavailableError`. Reconnects with capped backoff.
- **Follower mode.** `pty.create` answers `{winsizeOwner: false, cols, rows}`
  when main has a desktop window attached to that pane (tracked in a small
  `electron/pty-attachments.ts` from `pty:create`/`close`/`detach`).
  `useTerminalResize` takes a `follower` flag: it stops sending fits and
  instead sets `term.options.fontSize` so `cols` fit the container (ceiling 12,
  floor 6, then horizontal scroll). Incoming `resized` events already reach the
  emulator through `useTerminalStream` (ADR-164).
- **Unavailable states.** `BrowserPane` on the web renders an empty state with
  a `<Link>` to open the URL in a new tab; native-only actions are hidden
  behind `bridge.platform === "web"`; `layout.save` is refused once with a
  toast naming the intermediate state.
- **E2E.** `tests/e2e/web-app.spec.ts`: pair at `full`, open `/app#…` in a
  1280×800 Playwright page, assert the seeded project and a live terminal
  driven by the fake agent, type and see output, assert the desktop pane's
  `cols` did not change, assert a `send` device is refused at `/ws`.
- **Docs.** `docs/remote-control.md` gets the `full` tier and the web app;
  `docs/agents/domain.md` stops saying `CONTEXT.md` is unauthored.

## Consequences

**Better.** One codebase for every screen; the desktop gets the responsive
pass for free once slice 4 lands. The cloud host is "point the bridge at a
different URL" rather than a rewrite. The `electron/ipc/` vs `electron/routes/`
drift (219 methods vs ~100 routes) has an end date instead of a policy.
Follower mode reuses a rule ADR-177 already measured.

**Harder.** The `full` tier is a genuinely larger exposure than anything
`docs/remote-control.md` currently promises its reader; the doc's honesty about
scrollback has to extend to "and can remove a workspace". Every host-side
feature now has to land in the WebSocket handler table, and until slice 3 also
in `ipc/` — the drift gets briefly *worse* before it ends. The desktop's
first paint will one day wait on a localhost socket; `useTerminalStream`'s
warm-restore sequencing is the piece that has to survive that.

**Risks.** Serving the desktop bundle from the tunnel exposes far more
JavaScript unauthenticated than the 16 KB remote client did — no data, but a
much larger map of what the machine can do. Placing winsize ownership in main
is correct only while every host has an Electron main; the daemon move is
scheduled, not optional. The read-and-type intermediate state will be reported
as a bug by anyone who did not read this file.

**Known gaps after slice 1 (ticket 5's report), owned by slice 2.** Winsize
ownership is claimed at `pty.create` and never transferred: two browsers on
one desktop-free pane are both told they own it, and a follower is not told
when the desktop lets go mid-session. Both need the bridge's sockets tracked
in `pty-attachments.ts` and an ownership event on the bridge; neither is
needed for a PC browser next to a running desktop, which is what slice 1
proves.

**Not decided here.** Cloud authentication. The shape of the shared layout
package. Whether the remote client ever moves off HTTP+SSE (currently: no).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
