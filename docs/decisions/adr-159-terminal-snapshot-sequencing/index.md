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

Reattaching also stops guessing whether a session exists. `getSnapshot` (and
`attach`, for consistency) answers `notFound` — a fact — rather than an `error`
the client has to interpret, and a fresh shell is spawned only on that answer. Reading any failure as "not there"
hands a live session to a terminal that believes it is new, which drops the
snapshot and the dedupe along with it.

**Main process** (`app-lifecycle.ts`, `ipc/pty.ts`, `preload.ts`)

Forward `seq` with each `pty-output-*` message, and return `snapshotSeq` from
`pty:create`. (`electron/pty.ts`'s in-process `PtyManager` also sends on that
channel, but nothing imports it — it is left alone rather than kept in sync
with a protocol it never speaks.)

**Renderer** (`useTerminalStream.ts`, `useTerminalLifecycle.ts`)

The existing output queue holds `{ seq, data }`. Syncing a terminal with its
session is one operation and lives in one place: `openRestored(term, snapshot)`
writes the snapshot, then the queued chunks it does not already cover, then
lets output through live. A fresh session passes no snapshot, so nothing is
dropped. The queue re-arms on detach, so every attach gets that ordering rather
than only the first of a component's life.

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

- `seq` becomes part of the daemon↔app protocol, and it is optional on the wire
  because version skew is real: the daemon outlives the app, so a new app meets
  an old daemon that sends no `seq`. Absent means "cannot dedupe, apply
  everything" — exactly today's behavior.
- A snapshot reports the position its *screen* has applied, not the position
  broadcast. The two diverge only when `flushHeadless` gives up (2s), and
  reporting the broadcast position there would tell the client to drop output
  the screen never received.
- Four layers gain a field that must be threaded consistently. The mitigation is
  that the interesting logic sits in one pure function with direct tests.
- Sequence numbers count events, not bytes. That is enough for dedupe, and it
  keeps the daemon from having to track byte offsets across encodings.

**Test-harness fallout found on the way**

- The e2e fixtures forwarded the whole environment to the app under test,
  including `VITE_DEV_SERVER_URL`. Any run from a `pnpm dev` shell was testing
  the dev server rather than the build — and once that server exits, every test
  fails on a blank error page. Launch and teardown now live in one helper that
  strips it, instead of two copies that both inherited the bug.
- The shell-readiness probe retyped its command when the shell swallowed it.
  Under load every retry can land inside the same window, and for tests that
  count occurrences a retyped command inflates what they assert. It now waits
  for the session's scrollback to stop growing instead.

**Notes for whoever builds remote workspaces**

The daemon↔client protocol is the seam a remote backend would run over (see the
`WorkspaceBackend` abstraction from ADR-107), and two things here matter more
there than they do locally:

- **The absent-`seq` fallback is load-bearing, and not only remotely.** An
  earlier draft of this ADR claimed local skew was nearly unreachable, because
  `TerminalHostClient.connect` replaces a daemon whose version differs. That
  reasoning was wrong, and it broke a running app within two days: the check
  compares *app* versions, so two builds of the same release meet across a
  protocol change and the stale daemon is kept. A daemon that had been running
  since before this ADR answered a missing session with `error`, the new client
  demanded `notFound`, and every new terminal failed to start. Hence
  `TERMINAL_HOST_PROTOCOL`: the daemon reports what it speaks in the handshake,
  and a client that meets protocol 0 reads absence the old way. Over SSH the
  same fallback matters more, since killing someone else's daemon is not an
  option.
- **Sequence numbers are what a resumable stream needs.** A client whose link
  drops could reattach saying "I have through N" and receive only what it
  missed. The daemon keeps no per-position buffer today, so this is not
  implemented — but the number it would key off now exists.

Round trips also cost more there: the handshake is three of them, which is
nothing over a unix socket and real over SSH. Collapsing them belongs with the
transport work rather than ahead of it, since that work reshapes this client
anyway.

**Explicitly not covered**

- The premature launch-time measurement itself. With this change its only
  remaining cost is a resize the TUI repaints from — correctly. Fixing the
  measurement is a separate concern, and the deferral experiment showed it needs
  care around shell startup.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
