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

# ADR-179: Layout owned by the Manor server

ADR-178 slice 2. Reading ADR-178 D4, D6 and D10 first is assumed; the
vocabulary is in `CONTEXT.md` (**Layout command**, **Viewport**, **Default
viewport**, **Claim**, **Detached window**).

## Context

ADR-178 shipped the desktop renderer in a browser as *read-and-type*: a browser
can watch and drive any session, and every layout change it makes is local,
unsaved, and invisible to the desktop. The reason is structural, and this ADR
removes it.

### The renderer is the authority

`src/store/app-store.ts` (3.4k lines) holds `workspaceLayouts: Record<path,
WorkspaceLayout>` — `panelTree` → `panels{ tabs{ rootNode, title,
focusedPaneId }, selectedTabId, pinnedTabIds }` → `activePanelId` — and about
25 actions that mutate it (`splitPane`, `closeTab`, `moveTabToPanel`, …). A
zustand `subscribe` (line ~3430) debounces the *active* workspace into
`layout.save(workspace)`; main's `LayoutPersistence.saveWorkspace` does a
read-modify-write of `~/.manor/layout.json` (v2) on every call. Two renderers
of the same host are two authorities writing one file, last writer wins, and
neither hears the other.

Everything that is *not* the renderer already treats the renderer as the
authority: MCP and the CLI drive layout through `proxyToRenderer("split-pane")`
— 25 app-commands, 640 lines in `src/lib/app-commands.ts` — which means
`manor split-pane` fails when the desktop window is closed, even though on
macOS the app, the Manor server and the daemon all keep running
(`app-lifecycle.ts:610`). `GET /panes` for the MCP `list_panes` tool is the
same round-trip.

### The pieces are already pure

`src/store/pane-tree.ts` (12 functions) and `panel-tree.ts` (8) are pure and
tested. `terminal-host/layout-persistence.ts` duplicates their types with a
comment saying it cannot import them; it can — `electron/` already imports
runtime code from `src/lib/` (`pr-info`, `keybinding-defs`, `menu-commands`,
`push-error`), and `electron/mcp/tools-panes.ts` imports `LayoutSnapshot` from
`src/store/`. What is *not* pure is the structural logic inside the store
actions, which is interleaved with PTY creation, closed-pane stacks and
per-pane side maps.

### Two things the file conflates

`layout.json` persists `selectedTabId`, `focusedPaneId` and `activePanelId`
next to the tree. They are what *one window is looking at*. Sharing them across
renderers means flipping tabs on a phone flips the desk; not persisting them
means the desktop reopens on tab 1. The grilling resolved this as the IDE
model: **tab set shared, selection local, persisted per renderer**.

### Detached windows are a second authority

ADR-156/157 give a detached window its own store and move a tab into it by a
one-shot `DetachedTabPayload` hand-off (~700 lines across `window-handoff.ts`,
`DetachedApp.tsx`, `detach-types.ts`, `ipc/window.ts`). Under a shared layout
that hand-off either removes the tab from the workspace — so a browser stops
seeing a tab that is very much still open on the desk — or it stays a
separate authority. Neither is acceptable once "the browser mirrors the
desktop" is the promise.

### Slice-1 gaps this closes

Winsize ownership (ADR-178 D5) is claimed at `pty.create` and never
transferred: bridge sockets are not tracked in `pty-attachments.ts`, so two
browsers on a desktop-free pane both think they own it, and a follower is not
told when the desktop lets go. There is no theme broadcast, so a second viewer
never sees a theme change.

## Decision

**D1 — Commands, not state.** A renderer never writes layout. It sends a
**layout command** — `{ type: "split-pane", workspacePath, paneId, direction }`
and its ~20 siblings — over the bridge (`layout.apply`). The Manor server runs
the reducer, bumps a per-workspace version, persists, and broadcasts
`layout.changed { workspacePath, version, layout }` to every window and every
bridge socket. Renderers **replace** their replica on broadcast; there is no
optimistic apply and no second reducer. On the desktop the round-trip is IPC —
a split landing one frame later is invisible, and it is what makes conflicts
impossible rather than rare. **Commands carry explicit ids.** "Split the
focused pane" is resolved by the sender from its own viewport before sending;
the server never knows what any window is looking at.

**D2 — One pure model, in `src/lib/layout/`.** `pane-tree.ts` and
`panel-tree.ts` move there with their tests, joined by `workspace-layout.ts`:
the `WorkspaceLayout`/`Panel`/`Tab` types and `applyLayoutCommand(layout,
command) → { layout, effects }`, extracted from the store actions. `effects`
names what the *host* must do after a structural change — `killPanes: [ids]`
for a closed terminal pane — so the reducer stays pure and the server, not the
renderer, ends sessions. `terminal-host/layout-persistence.ts` imports the
types instead of duplicating them. Same precedent as `app-menu.ts` importing
`menu-commands`.

**D3 — Structure vs viewport, precisely.**

| Field | Was | Now |
| --- | --- | --- |
| `panelTree`, `panels[].tabs[]` (rootNode, title, pinnedTabIds) | structure | structure |
| `paneSessions` (daemonSessionId, lastCwd, lastTitle, lastAgentStatus) | renderer-written | structure, **server-derived** from the PTY events main already forwards |
| closed-pane stack (`reopenClosedPane`) | renderer memory | structure, server memory, not persisted |
| `panels[].selectedTabId`, `tabs[].focusedPaneId`, `activePanelId`, active workspace | structure | **viewport** |

Viewport is a separate store slice, keyed by workspace, persisted **per
renderer**: the primary desktop window in `~/.manor/viewport.json` through a
tiny `viewport.load/save` pair, a browser in `localStorage`. Each renderer
reports its viewport to the server (`layout.reportViewport`), which keeps one
**default viewport** per workspace and hands it to a renderer that has none.
`layout.json` becomes **v3**: focus fields leave the tree, `defaultViewport`
joins each workspace, and v2 migrates on first load by copying its focus
fields into both the default and the primary's viewport file.

**D4 — A detached window is a claim.** The tab never leaves the workspace's
structure. A desktop window's viewport may include `claim: tabId`; the server
keeps `claims: Map<windowId, tabId>` from viewport reports, includes them in
every `layout.changed`, and the primary window hides claimed tabs. A browser
is never a claimant and always sees the whole workspace. Closing the window
releases the claim and the tab reappears in the primary — today's reattach,
for free. `DetachedTabPayload`, `window-handoff.ts`, `DetachedApp.tsx` and
`removeDetached{Tab,Pane}Locally` are deleted; `DetachedApp` is `App` with a
viewport of one claim. Claims are exclusive: a second claim on the same tab
wins and the first window drops it.

**D5 — MCP and the CLI hit the server.** Structural routes in
`electron/routes/panes.ts` call the layout store directly and no longer need a
window. Viewport routes (`focus-*`, `select-tab`, `next/prev-tab`,
`set-active-workspace`) stay `proxyToRenderer` to the primary, because "which
window?" has no server-side answer. `GET /panes` builds `LayoutSnapshot`
server-side from structure plus the primary's last reported viewport.
`src/lib/app-commands.ts` shrinks to the viewport commands.

**D6 — Winsize ownership transfers.** Bridge connections get an id and are
tracked in `pty-attachments.ts` next to desktop viewers. The owner of a pane is
recomputed on every attach and release — the desktop if any desktop window
holds the pane, otherwise the most recently attached web viewer — and a change
is pushed as `pty.winsizeOwner { paneId, cols, rows }` with a per-socket
`owner: boolean`. The renderer flips between fit and follower live. A
`theme.changed` broadcast joins `renderer-broadcast.ts`.

**D7 — The browser arranges.** The `layout.save` refusal and its once-toast
go. Split, new tab, close, move, pin from a browser are ordinary commands and
show up on the desk. ADR-178's "read-and-type" paragraph in
`docs/remote-control.md` is replaced.

### What stays deliberately out

- Per-workspace *layout* is still keyed by workspace path; a cloud host with a
  different path scheme is ADR-160's problem, not this one's.
- Drag-to-split and drag-tab in a browser remain mouse-only; there is no touch
  idiom (ADR-178 D9, slice 4).
- No CRDT, no patches: a `layout.changed` carries the whole workspace layout.
  It is a few KB and the server is the only writer.

## Consequences

**Better.** One authority, one reducer, one command vocabulary shared by the
desktop UI, the browser, MCP and the CLI. `manor split-pane` works with the
window closed. A browser sees every tab, including ones popped out on the
desk. Detach loses ~700 lines and a whole payload type. The daemon, the routes
and the bridge all get simpler because nothing asks a window for the truth any
more. `app-store.ts` loses its largest and most side-effectful actions.

**Harder.** This touches the app's spine: every layout action, the boot path,
persistence, detach, MCP's pane tools and the E2E fixtures that assume the
renderer saves. The 24 files that read `workspaceLayouts` do not change, which
bounds it, but the store's action semantics change under them. The desktop's
first layout paint now waits on `layout.getAll()` instead of a synchronous
file read — same as it already waits on `projects.getAll()`.

**Risks.** A reducer bug is now a server bug that every renderer sees at once.
The v2→v3 migration runs once on real users' files; it must be idempotent and
must never lose a tab. `effects.killPanes` moves session-ending from a place
with a confirmation dialog in front of it to the server — the *command* must
therefore be sent only after the dialog, which is how the actions already
behave. Claims are a new bit of server state that must be cleared on window
death or a tab becomes invisible everywhere.

**Deliberately dropped with the hand-off.** Dragging a tab or pane *into*
another desktop window no longer transfers it: from a detached window the
gesture closes it (the tab is already in the primary), from the primary it is
a no-op. "Drop onto a specific window" would mean "that window claims this
tab" — a small new IPC, not built here.

**Amends.** ADR-156 and ADR-157 (detach semantics), ADR-152 (`list_panes`
source), ADR-178 D10's intermediate state.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
