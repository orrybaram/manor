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

# ADR-159: Sequence-numbered snapshots for terminal warm restore

## Context

A terminal that reattaches to a live daemon session can show the same output
twice. The visible symptom is a full-screen TUI's banner or frame printed a
second time right after the app starts — the Claude Code header line appearing
twice in a restored pane.

### How a warm restore works today

`TerminalHostClient.doCreateOrAttach` (`electron/terminal-host/client.ts:186`)
runs three steps against a session the daemon already has:

1. `getSnapshot` over the control socket — the daemon flushes its headless
   xterm and serializes it (`session.ts:440`).
2. `resize` — the new terminal's measured cols/rows are pushed to the PTY.
3. `subscribe` over the stream socket — the renderer starts receiving `data`
   events.

The renderer writes the snapshot, then writes everything the stream delivers.

### Why that duplicates

The three steps are separate round trips, and the PTY keeps producing output
across all of them. That leaves two windows where the same bytes can be counted
twice or not at all:

- **Bytes emitted between the snapshot and the subscribe are lost.** They are in
  the daemon's headless terminal but reach no client.
- **Bytes emitted after the snapshot but delivered on the stream are applied on
  top of a screen that already reflects an older state.** For a TUI this is
  worse than a plain repeat: a frame redraw is a sequence of cursor-relative
  moves and erases. Replayed against a screen whose cursor sits somewhere the
  daemon did not assume, the erase lands in the wrong place and the frame is
  appended instead of replacing what was there.

Step 2 is what reliably provokes the second case: resizing the PTY raises
SIGWINCH, and a full-screen TUI answers by repainting. So the resize both
happens after the screen was captured and generates exactly the kind of output
that misapplies.

The resize itself is not spurious. `session.resize` (`session.ts:363`) already
ignores no-op resizes, so a resize on attach means the terminal genuinely
measured a different size than the session had. Session metadata confirms this
happens in practice: a pane restored at app launch recorded `101x37` in its
`meta.json`, while panes opened later in the same window record `136x40` — the
launch-time measurement runs before the window and sidebar have settled.

### What was already tried

Deferring the attach until the pane's box stopped moving fixed the measurement
but was abandoned: delaying session creation by up to 500ms pushes shell startup
into the window where zsh's line editor is still initializing, and keystrokes
typed right after opening a terminal were silently discarded. That trade is
worse than the bug.

The renderer already queues live output until the snapshot has been written
(`useTerminalStream.openOutput`). That fixes ordering but not identity — the
queue cannot tell which of its chunks the snapshot already accounts for.

## Decision

Give the session's output stream a monotonic sequence number, and stamp the
snapshot with the position it was taken at. The renderer then has enough
information to apply every byte exactly once, regardless of how the three round
trips interleave.

**Daemon** (`session.ts`, `types.ts`)

- `Session` keeps an `outputSeq` counter, incremented for every broadcast `data`
  event. Each `data` event carries its `seq`.
- `TerminalSnapshot` gains `seq`: the value of the counter at the moment the
  headless terminal was serialized.

**Client** (`client.ts`)

Reorder `doCreateOrAttach`'s warm-restore branch to `resize` → `subscribe` →
`getSnapshot`. Subscribing before snapshotting closes the loss window: anything
emitted from that point on reaches the renderer. Resizing first means the
repaint it provokes is either already in the snapshot or arrives with a higher
`seq` — either way it is applied once. The snapshot's `seq` is returned
alongside it.

**Main process** (`app-lifecycle.ts`, `ipc/pty.ts`, `preload.ts`, `pty.ts`)

Forward `seq` with each `pty-output-*` message, and return `snapshotSeq` from
`pty:create`. The legacy in-process PTY backend emits an incrementing `seq` too,
so the renderer sees one shape.

**Renderer** (`useTerminalStream.ts`, `useTerminalLifecycle.ts`)

The existing output queue holds `{ seq, data }`. `openOutput(term, snapshotSeq)`
drops queued chunks whose `seq` is at or below the snapshot's, writes the rest
in order, and lets subsequent output through live. A fresh session has no
snapshot, so nothing is dropped.

The dedupe rule is extracted as a pure function so it can be unit-tested without
a terminal or an IPC bridge.

## Consequences

**Better**

- Warm restore is correct by construction rather than by timing. The duplicate
  banner goes away, and so does the matching loss window nobody had noticed.
- The attach path no longer has to avoid resizing, so the terminal can keep
  measuring itself whenever it likes.
- Attach stays immediate: no added latency, and no risk to keystrokes typed the
  moment a pane opens.

**Harder / riskier**

- `seq` becomes part of the daemon↔app protocol. A new app talking to an old
  daemon sees `seq: undefined`; the renderer must treat a missing `seq` as
  "cannot dedupe, apply everything", which is exactly today's behavior. Version
  skew is real here because the daemon outlives the app.
- Four layers gain a field that must be threaded consistently. The mitigation is
  that the interesting logic sits in one pure function with direct tests.
- Sequence numbers count events, not bytes. That is enough for dedupe, and it
  keeps the daemon from having to track byte offsets across encodings.

**Explicitly not covered**

- The premature launch-time measurement itself. With this change its only
  remaining cost is a resize the TUI repaints from — correctly. Fixing the
  measurement is a separate concern, and the deferral experiment showed it needs
  care around shell startup.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
