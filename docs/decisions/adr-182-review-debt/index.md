---
type: adr
status: proposed
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

# ADR-182: Pay down the ADR-178–181 review debt

ADR-178 through ADR-181 (web app, server-owned layout, one host surface, phone
layout) landed on `feat/adr-181-phone-layout`: 131 commits, 363 files,
+40k/−11k. A strict code-quality review of the branch found that the three
central decisions are right, and that the code around them is not. The
central decisions are one pure layout reducer shared by server and renderer,
one `BridgeServer` fed by two transports, and phone state that is the
existing viewport.

## Context

### Regressions the review found
1. **MCP/CLI pane titles are invisible.** `POST /panes/:id/title` became a
   `set-pane-title` layout command. `LayoutStore.applyNow` intercepts it,
   writes `paneSessions`, and broadcasts nothing (`layout-store.ts:626`).
   Before the branch, the route proxied to the renderer.
2. **`full` devices reach host-local controls over HTTP.** ADR-178 D3 gave
   `full` the whole HTTP route table. ADR-180 later marked
   `remoteControl.setEnabled/pair/revoke/startTunnel/stopTunnel` local-only on
   the bridge. The HTTP routes `/remote-control/enabled` and
   `/remote-control/tunnel/{start,stop}` remain open to `full`. Two surfaces
   apply two policies.
3. **Reopening a closed browser pane loses its URL.** `ClosedPaneEntry.url`
   is written and never read.
4. **CLI/MCP `remove_workspace` leaves the server layout behind.** Only the
   renderer tears it down, one panel at a time, behind a module-level
   `removingWorkspaces` set.
5. **`handleNewAgentWithPrompt` (App.tsx) hand-rolls the launch line** and
   skips `flattenPrompt`, which brings back the ADR-176 newline bug.
6. **A follower terminal keeps its shrunk font after it becomes the owner.**
   `useTerminalResize` sets `term.options.fontSize` and never restores it.

### Structural debt
- **Hand-synced parallel declarations.** The same fact is declared in several
  places that must be edited together:
  - the bridge's method list: `handlers/*.ts`, the pass-through table in
    `handlers.ts`, four string-keyed rule lists, `electron.d.ts`, and the
    name-only `surface.ts` check
  - the event-name maps (three)
  - the subscription registries (three, already behaving differently)
  - the command ids (about seven lists)
  - the wire types (three)
  - the layout test fake, which re-implements the server
- **Files over 1k lines.** Four files cross 1k lines because of per-case
  repetition, not inherent complexity:
  - `electron/bridge/handlers.ts` (1268)
  - `src/lib/layout/commands.ts` (1490)
  - `electron/routes/panes.ts` (233 → 1037)
  - `src/electron.d.ts` (1287)
- **Scattered phone and web checks in shared UI.** Examples: drag disabled in
  six places, 11 `if (webApp) return` guards in BrowserPane, and a phone
  branch copied into both split components.
- **Stale web guards.** Some guards contradict the ADR-180 bridge: the settings
  pages lock fields whose methods are on the bridge table.
- **The renderer still applies tree data optimistically**
  (`paneContentType`/`paneUrl`), contrary to ADR-179 D1.

## Decision

Keep every accepted decision in ADR-178–181. Delete the parallel declarations
by deriving them from one source each.

**D1 — Pane titles leave the command channel.**
- `LayoutStore.setPaneTitle(paneId, title)` finds the owning workspace, writes
  `paneSessions`, and publishes a pane-title event that renderers feed into
  `setPaneTitleFromStream`.
- `set-pane-title` leaves `LayoutCommand`.

**D2 — The bridge is the only surface for `full` devices.**
- Over HTTP, a `full` device gets the `send` table.
- Everything a `full` device can do beyond `send` goes through `/ws`, where the
  bridge's local-only and audit rules already apply.
- This amends ADR-178 D3: authentication is still the boundary, but there is
  one surface, not two.

**D3 — One table per bridge namespace, with its rules alongside.**
- Every handler takes `(ctx: { deps, caller: { id, callerClass } }, ...wireArgs)`.
- Each `electron/bridge/handlers/<ns>.ts` exports its namespace as
  `{ method: method(fn, { mutating?, secretFirstArg?, localOnly? }) }`.
- `handlers.ts` becomes a flatten of those tables.
- The mutating, secret-first-arg and local-only lists are derived from the tables.
- The following all go:
  - `ORIGIN_ARG_COUNTS` and the argument padding
  - `viewerOf`
  - optional `origin?` parameters
  - `to === null` fallbacks
- The browser's `SERVED_HERE` list imports the local-only rule instead of
  restating it.

**D4 — The contract is derived, not checked.**
- `ElectronAPI` is built from parts: `ClientOf<typeof HANDLERS>`, a typed
  `NativeApi`, host facts and listeners.
- Listener names come from the one `SUBSCRIPTIONS` table.
- `surface.ts` shrinks to what cannot be derived.
- Layout wire types live in `src/lib/layout/protocol.ts`, imported by both
  sides.

**D5 — One transport core.**
- One `SubscriptionRegistry` (reference-counted) serves the preload and the WS
  transport.
- Both transports return the `ResultFrame`, and one `settle()` handles it.
- `BridgeServer.receive(conn, raw)` owns frame decoding and routing.
- Shared constants live in `electron/bridge/types.ts`.
- A detached window is identified only by its `claim`; `isDetached` and
  `detachedWindowId` go.

**D6 — Layout commands are take + graft.**
- The reducer gets two primitives: `take(layout, target)`, which applies one
  empty-panel rule, and `graft(layout, target, subtree)`.
- Dispatch is a handler table typed by command type. `isLayoutCommandType` is
  derived from it, which retires `COMMAND_TYPES`.
- `fallbackTab`/`fallbackPanelId` go, and `split-pane` folds into `split-pane-at`.
- The reducer returns `{ layout, closedStack, killPanes, hint? }`.
- `apply` returns `{ version, hint, addedPaneIds }`.
- Closed panes store their leaf and are reinserted whole.
- The module splits into `src/lib/layout/commands/`.

**D7 — `LayoutStore` owns the pane lifecycle.**
- `killPanes` goes through an injected agent service that abandons agents.
- `LayoutStore.remove()` kills the workspace's panes, and `removeWorktree`
  calls it.
- The renderer only drops its copy.

**D8 — Routes are thin.**
- Tab builders live in `src/lib/layout/tabs.ts`, shared by the store and the
  routes.
- `LayoutStore.locate({ paneId | tabId })` is public.
- One structural-route factory handles the repeated setup.
- `routes/panes.ts` splits into files under 400 lines each.
- Routes and the bridge share one non-null `HostDeps`. The routes call the
  bridge handlers instead of re-implementing them.

**D9 — The renderer holds no optimistic tree data.**
- `paneContentType` and `paneUrl` are read from the tree.
- One layout map plus a `mountedWorkspaces` set replaces the two maps.
- Store tests run against the real `LayoutStore` with in-memory persistence.

**D10 — One command table.**
- `COMMANDS` holds `{ id, label, category, defaultCombo, scope, native?, run }`.
- The keybinding defaults, the menu lists, the native-only list and the
  palette's static items are derived from it.
- The web filter applies once, at the table.

**D11 — Phone and web are seams, not sprinkles.**
- `PaneDragProvider` exposes `dragEnabled`.
- The web app mounts `BrowserPaneUnavailable`.
- One `SplitFrame` serves both split components.
- `PhoneChrome` owns the phone shell in `App.tsx`.
- One `paneTitle()` helper serves the tab bar, tab titles and the switcher.
- Stale slice-1 web guards are deleted.

## Consequences

- **Better.**
  - Adding a bridge method, command or event means one edit.
  - The compile step checks argument and return types across the bridge.
  - All four oversized files drop under 1k lines.
  - The six regressions are fixed.
  - The store tests exercise the real server.
- **Harder.**
  - A large mechanical churn on an unmerged branch.
  - Many tickets touch shared files, so they run sequentially.
  - The derived `ElectronAPI` type is more type-level machinery than a
    hand-written interface, so errors will read less plainly.
- **Risks.**
  - Behaviour drift during the reducer rewrite. The existing
    `commands.test.ts` (1283 lines) is the guard, and each ticket keeps it green.
  - D2 removes HTTP-only abilities from `full` tokens. Any external script
    using a `full` token over HTTP for write routes beyond `send` must move to
    `/ws`.
  - The e2e suite must pass at the end.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
