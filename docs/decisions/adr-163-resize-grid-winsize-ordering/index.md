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

# ADR-163: A resize moves the grid and the winsize in a safe order

## Context

Drag a Manor window edge for a few seconds with an agent running in a pane and
the agent's frame is left behind on screen over and over, until the scrollback
is mostly copies of it (issue #169). ADR-159 fixed duplication on *reattach*;
this is duplication with nothing reattaching at all.

### What actually duplicates

Nothing that is printed once duplicates. A 4000-line stream resized through the
whole drag comes out exactly once, and so does a shell prompt — zsh's SIGWINCH
redraw overwrites itself cleanly. What duplicates is a frame a program
**repaints in place**: draw N lines, move the cursor back up N lines, draw them
again. Every inline agent harness works this way.

That repaint is only correct while the frame occupies the N rows the program
counted. It counts them from the terminal width it was last told about — the
kernel's winsize, read on SIGWINCH. So the repaint is correct exactly while the
emulator's grid and the pty's winsize agree.

### Why they disagree

They are moved by two different pieces of code, in the wrong order:

- The grid is `xterm.js`, in the renderer. `useTerminalResize`'s ResizeObserver
  called `fitAddon.fit()` on the next animation frame, which resized the grid
  **immediately**.
- The winsize is three hops away: IPC → daemon → pty subprocess → `ioctl`.
  `useTerminalLifecycle` sent it from `term.onResize`, debounced by 150ms, and
  the debounce restarted on every step of a drag — so through a continuous
  drag the program was never told at all.

While the grid is narrower than the width the program is drawing for, every
full-width line it draws wraps. The frame then spans more rows than the
program's cursor-up moves back over, so its next repaint lands *below* the copy
it meant to overwrite. That copy is stranded, and scrolls up into the
scrollback. Once per repaint, for as long as the two numbers disagree.

The reverse disagreement is harmless: a grid *wider* than the program believes
just leaves unused columns on the right.

### Rows fail the same way, and this ADR first said they did not

A program sizes the region it repaints from the *rows* it was last told it has,
so the grid holding fewer rows than the pty breaks the repaint too — by a
different route. The region no longer fits on screen: its top has already
scrolled off, `ESC[nF` clamps at row 0 rather than reaching it, and the redraw
lands below the copy it meant to replace. Cursor-up cannot move above the top of
the screen. That is the whole of why the first version's "shrinking rows only
scrolls, which every cursor-relative repaint already copes with" is wrong — a
cursor-relative repaint copes with scrolling only while the region still fits.

How much it strands depends on how tall the repainted region is, which is why it
survived the regression test. Replaying a drag against a headless emulator, with
the region height as the parameter, and counting the frames left on screen:

| region height | grid follows container | grid never drops below pty |
| ------------- | ---------------------- | -------------------------- |
| 11% of screen | 1.0                    | 1.0                        |
| 25%           | 1.0                    | 1.0                        |
| 50%           | 1.0                    | 1.0                        |
| 80%           | 2.3                    | 1.0                        |
| 95%           | 20.0                   | 1.0                        |

`fake-tui.sh` repainted a fixed five lines — 11% of a 45-row pane, the leftmost
column of that table. It was green through the bug because five lines always
fit. An agent mid-turn is the right-hand end of the range.

### A settle window shorter than a hand's pauses

The other half is that the coalescing was not coalescing. `SETTLE_MS` was 150ms,
which is *below* the pauses a hand makes while dragging a window edge — so a
drag settled in every one of those pauses. Measured against a live session:
Claude Code drew its full-width rule at **37 distinct widths** during one bout of
resizing, and re-rendered its transcript 147 times. Rule 2 was written to make
that number one.

| settle | hand pauses ~120ms | ~190ms | ~260ms | ~340ms | ~450ms |
| ------ | ------------------ | ------ | ------ | ------ | ------ |
| 150ms  | 6                  | 12     | 11     | 10     | 9      |
| 250ms  | 1                  | 1      | 11     | 10     | 9      |
| 400ms  | 1                  | 1      | 1      | 2      | 8      |

(pty resizes per six-second drag)

Removing the debounce alone was measured and is not enough — the app-level
acknowledgement said nothing about the ioctl. `pty:resize` resolved as soon as
the daemon had *written* a resize frame to the pty subprocess's stdin, roughly
1ms, long before the `ioctl` had happened.

Removing the debounce and keeping it removed is also wrong, and that took a
second reproduction to see. Every width the pty is told costs the program a
repaint, and a repaint is the only thing that can strand a copy. A drag with no
debounce is sixty of them. The original 150ms debounce was doing real work; its
mistake was debouncing only *half* of the size change, leaving the grid to move
at once and the pty to find out later.

### The second, quieter half

Even with the winsize moved first, shrinking the grid the instant the ioctl
lands still strands one copy per resize. The frame *already on screen* was
drawn for the old width; shrinking the grid reflows it into twice the rows, and
the program's next repaint lands below its own stale copy. The grid has to wait
until the program has replaced that frame.

Nothing in the byte stream says when that has happened. "The next chunk after
the ioctl" was tried and is wrong: it holds only for a program that idles
between frames. An agent mid-turn is streaming, so the next chunk is more of the
work already in flight, the grid shrinks on it, and the stranding is back. The
first version of this ADR shipped that assumption because the test agent slept
between repaints — a fake that was quieter than the thing it stood for.

The honest signal is quiet: the program has *stopped* reacting. For one that
never stops talking there is no signal at all, only a bounded grace period.

## Decision

One component owns "the pane changed size", under two rules.

**The grid never drops below the pty, in either dimension.** Growing applies at
once; shrinking waits for the handoff below. Correctness rests on this rule
alone, and it is symmetric: rows are no safer to move freely than columns.

**A drag is one size change, not sixty.** Sizes are coalesced until the pane has
held still for `SETTLE_MS`, which is 400ms — above the pauses a hand makes
mid-drag, which is what the old 150ms failed to clear. This rule is economy, not
safety: with rule 1 holding, a repaint cannot strand a copy at any size, but
every width the pty is told still costs the program a full re-render of its
transcript. Through a shrinking drag the grid only grows, so the outermost rows
and columns are clipped for that settle window and then come back; that is the
price, and it is paid on a transient.

The handoff, once the size has settled:

1. Resize the pty, and wait for the ioctl to actually land.
2. Give the program a bounded moment to redraw — resolving early on 60ms of
   quiet from the pty, and after 300ms regardless.
3. Shrink the grid, unless the pane moved again in the meantime, in which case
   the settle already pending owns it.

**Renderer** (`useTerminalResize.ts`, `useTerminalLifecycle.ts`,
`useTerminalStream.ts`, `useTerminalConnection.ts`)

- `useTerminalResize` stops calling `fit()` and drives the sequence itself off
  `proposeDimensions()`. It takes the resize call and a `awaitApplied(seq)` from
  the stream hook. `term.onResize → resize()` — and its 150ms debounce — is gone
  from `useTerminalLifecycle`: one place decides the size.
- The ratchet itself is `growToward` in `src/lib/terminal-grid.ts`, extracted so
  the regression test drives the shipped policy rather than a copy of it.
- Size changes are **coalesced, not queued**. A drag produces them faster than
  they complete, and `applyFit` re-measures, so one run after the drag settles
  reaches the same place a queue of them would without spending a redraw per
  frame catching up.
- `useTerminalStream` records when output last arrived and exposes
  `awaitSettled(quietMs, graceMs)`. That is all step 2 needs; an earlier draft
  threaded a sequence position through for it and the position turned out to
  answer a question ("which chunk is the redraw") that has no answer.

**Daemon** (`session.ts`, `pty-subprocess.ts`, `pty-subprocess-ipc.ts`,
`terminal-host.ts`, `index.ts`, `types.ts`, `client.ts`)

- The pty subprocess answers a `Resize` frame with a new `Resized` (`0x17`)
  frame, *after* the ioctl — and flushes its batched output first, so no
  pre-resize byte can follow it on the wire.
- `Session.resize` returns a promise that resolves on that frame. Its signature
  is unchanged — `Promise<void>` — because nothing new needs to cross the
  boundary; what changed is *when* it resolves. The session's headless mirror is
  resized at the same moment, behind its own write queue, and always to the
  session's current size rather than to dimensions captured per pending ack.
- `TerminalHostClient.resize`, `PtyBackend.resize` and `pty:resize` keep their
  `Promise<void>` signatures. Nothing new crosses the boundary — an earlier
  draft threaded a stream position through all of them, and the position turned
  out to answer a question ("which chunk is the redraw") that has no answer.
  What changed is only *when* they resolve.
- `TERMINAL_HOST_PROTOCOL` goes to `2`, because a protocol-1 daemon answers
  `resized` before the ioctl and a client that shrinks its grid on that reply
  shrinks it too early. The bump forces such a daemon to be replaced.

## Consequences

**Better**

- The duplication is gone rather than reduced, and now it is gone for a
  repainted region of *any* height. Replaying a hand-shaped drag against a
  headless emulator, the frame goes from 163–186 copies unfixed to exactly one,
  at every region height from 11% to 95% of the screen — where the shipped
  column-only rule was still leaving 2.3 copies at 80% and 20 at 95%.
- The regression test moved down to unit speed
  (`src/lib/__tests__/terminal-grid.test.ts`), where the region height is a
  parameter rather than a constant the e2e could not vary. It carries three
  controls, including one asserting that a five-line frame passes under the
  broken policy — the specific way the old test was green through the bug.
- A resize is a fact the renderer can wait on instead of a message it fires into
  the dark.
- One number moves the pane's size instead of two moving independently, so the
  question "which of these is authoritative right now" no longer arises.

**Harder / riskier**

- A shrinking drag now clips its **bottom rows as well as** its right-hand
  columns. This is the real cost of the fix and it is worse than the
  column-only version was: the bottom of a pane is where an agent puts its
  input box, so during a drag that shortens the window that box is out of
  sight. Measured on a pane shortened by 260px: 254px of it — about fifteen
  rows — is clipped, and the pane is back to fitting its container about a
  second after the drag stops. The alternative is a stranded copy per repaint,
  which is permanent, but this is a trade and not a free win. Growing still
  applies immediately in both dimensions.
- The ratchet took away a correction nothing knew was load-bearing. `fit()` on
  every observer frame used to re-apply the proposed size outright, which
  quietly absorbed the fact that xterm re-measures its cell metrics *after* a
  resize — so the size it proposes mid-handoff can be a few rows off. With the
  grid only growing on its own, that stale proposal stuck, and the pane sat
  three rows taller than its container permanently. `handOff` now re-measures a
  frame later and runs again if the fit moved, bounded at eight passes. There
  is an e2e test on the geometry for this, because the search-oracle tests
  cannot see it: the rows are in the buffer either way.
- Step 2 is a heuristic with a ceiling, and it is worth being honest that it is
  one. A program that streams without pause through the grace period gets its
  grid shrunk anyway. Measurement since suggests this costs less than it looks:
  with rule 1 symmetric, the grace period made no difference to the copy count
  at any value from 16ms to 2s, because the grid never shrinks below what the
  program is drawing for in the first place.
- The subprocess must flush its batched output before it acks, so no pre-resize
  byte can arrive after the ack.
- The protocol bump means an app upgrade replaces a running daemon, ending live
  sessions — the same cost ADR-159's bump carried.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
