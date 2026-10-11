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

# ADR-220: Phone state resyncs after reconnects, and on demand

## Context

The phone/web client goes stale, and the only fix is to close the app and
open it again.

How it syncs today:

- Each store fetches its state from `window.electronAPI` once, at module load
  or when App mounts. After that it only listens for push events.
- Inventory of these one-off fetches:
  - agent-store `init` (agent-store.ts:110), not exported
  - project-store `loadProjects`
  - theme-store `loadTheme`
  - app-store `loadPersistedLayout`
  - notification-store `init` (:55), not exported
  - preferences-store (:37), inline
  - host-store (:52), inline
  - remote-control-store (:48), inline
  - ports-store `startScanner`
  - agent-activity `startAgentActivitySync`
  - terminal snapshot from `pty.create` (useTerminalConnection.ts:90), per pane
  - chat `getHistory` (ChatPane.tsx:78-148), per pane
- `WsTransport` reconnects with backoff, and on the new hello it replays every
  subscribe frame (`ws.ts:319-324`). It does not fetch state again. Any event
  published while the socket was down is lost, and the UI shows old data until
  some later event happens to overwrite it.
- Terminal `seq` numbers are only used to dedupe. Chat only re-fetches after the
  *host* went offline, not after a plain socket drop.
- iOS often kills a backgrounded WebSocket without firing `onclose`. On return,
  `retryNow()` (`install-web.ts:148-153`) is a no-op because no retry timer is
  pending and the socket still reports `open`. The heartbeat
  (`relay-pipe.ts`, 20s interval) only notices 20–40s later. In that window the
  UI looks connected but is stale.
- There is no way to refresh by hand short of killing the app. The
  `UnreachableScreen` "Try again now" button only shows once the page already
  knows the connection is gone.

## Decision

Three layers: re-fetch on reconnect, probe when the app returns to the
foreground, and manual refresh controls.

### D1. A resync signal

`src/bridge/resync.ts` exports:

- `onBridgeResync(cb: () => void): () => void`
- `emitBridgeResync(): void`

It is a plain listener set with no platform checks. On the desktop nothing
emits it, so the listeners stores register there never fire.

`install-web.ts` emits a resync on every accepted hello **except the first**,
because the first hello is the cold start the boot fetches already cover. Each
listener runs inside try/catch, so one throwing does not stop the rest.

### D2. Stores re-fetch on resync

Each store in the inventory above registers its fetch with `onBridgeResync`,
next to where it already subscribes to push events. Rules:

- **Refetch only.** No one-time side effects run again. For example,
  agent-store's `consumePruneNotice` stays boot-only.
- **Layout is applied as an update.** It goes through the same merge path
  `layout.onChanged` uses: a newer version wins, and the local viewport and
  selection are kept. `loadPersistedLayout` is not re-run whole, because it also
  sets the active workspace and runs `reconcileStale`.
- **Ports** run `scanNow()` only while the scanner is acquired.

### D3. Terminal and chat panes resync

- **Terminal:** each mounted terminal pane re-attaches on resync. It re-arms the
  output queue (`closeOutput`) and calls `pty.create` again for a fresh
  snapshot, using the same path as the existing remote re-attach
  (useTerminalLifecycle.ts:203). The existing seq dedupe joins the snapshot to
  live output.
- **Chat:** `ChatPane` calls its `fetchHistory` again on resync. Entries upsert
  by id, so merging is safe.

### D4. Probe on return to the foreground

`WsTransport` gains `checkNow(): void`:

- **A retry is pending:** reset `attempt` to 0 and dial now.
- **No socket:** dial.
- **Socket ready:** call `PipeConnection.probe(PROBE_TIMEOUT_MS = 2_000)`, a
  new optional method. If it returns false, call `PipeConnection.close()`, also
  new and optional, which reports a close with an unreachable code. The
  transport then redials immediately with `attempt` reset instead of waiting
  out the backoff.

The relay pipe implements both new methods:

- `probe` sends `HEARTBEAT_PING` and resolves true on any inbound message
  within the timeout.
- `close` uses `fail(CLOSE_RELAY_UNREACHABLE)`.

`install-web.ts` calls `checkNow()` on:

- `visibilitychange` → visible
- `pageshow`, including `persisted` restores from the back-forward cache
- `online`

`retryBridgeNow` stays as it is for the unreachable screen.

### D5. Manual refresh

`install-web.ts` exports `refreshBridge(): Promise<void>`. It probes. If the
line is dead, it reconnects, and the hello path then emits the resync (D1). If
the line is alive, it emits `emitBridgeResync()` directly.

UI on the phone:

- **Pull-to-refresh.** A `usePullToRefresh(ref, onRefresh)` hook in
  `src/components/phone/`. It starts only when the scroll container is at
  `scrollTop === 0`, uses a 64px threshold, and shows a small spinner
  indicator. It is wired to the ChatPane `.scroller` and the
  `PhoneAgentsPanel` list. Terminal panes are left out, because they disable
  vertical panning.
- **Overflow menu.** `PhoneOverflowMenu` gains two items, which are always
  present (so `hasItems` is always true):
  - **Refresh** calls `refreshBridge`.
  - **Reload app** calls `location.reload()`. The pairing is kept in storage.

## Consequences

- **Better:** A reconnect now fixes stale state without closing the app.
  Coming back from the background detects a dead socket in about 2s instead
  of 20–40s. A manual refresh is one tap away.
- **Cost:** Each reconnect re-fetches about a dozen namespaces, which is a
  burst of invokes over the relay. That is acceptable, since reconnects are
  rare and each fetch is small.
- **Risk: layout.** Re-applying layout must not undo an edit the user made
  locally during the drop. The version check guards against that, and ticket 2
  tests it.
- **Risk: terminals.** Re-attaching causes a visible redraw. Doing it only
  when a resync fires keeps that rare.
- **Not covered:** events dropped while the socket stays alive. Per-namespace
  sequence numbers or snapshot-on-subscribe would close that gap, and are left
  for a later ADR if staleness persists.
- **Desktop:** behaviour does not change. The resync signal never fires there.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
