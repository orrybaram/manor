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

# ADR-165: A grid that disagrees with the winsize stays wrong

ADR-163 and ADR-164 both read issue #169 as a question about the *transition* —
where in time, and then where in the stream, the two halves of a resize move.
ADR-164's answer is correct and is kept in full. This ADR is about the state
they leave behind: manor has no way to notice that the grid and the winsize have
stopped agreeing, and nothing that ever puts them back.

## Context

### ADR-164 landed, measured

Two harnesses, both driving **real Claude Code** through the same drag —
`/help` at 20 rows, so the frame is taller than the screen, which is the
condition the reporter identified ("it only affects lines that are off screen").
One runs the real `Session`, the real subprocess and the real broadcast stream
into a client emulator wired exactly as `useTerminalStream` wires it; the other
is a local terminal — `term.resize()` and `pty.resize()` in one function between
two reads.

| model | extra copies |
| --- | --- |
| local terminal | 3 |
| manor, after ADR-164 | 3 |

Identical. The daemon path has no gap left in it. Measured the same way, the
window between the ioctl landing and the `resized` event reaching a client is a
median of **1.5ms**, and across ten resizes **zero** `data` events overtook it.

So the duplication that is still being reported is not produced by the
transition, and the earlier plan to stop the emulator reflowing was aimed at the
wrong thing — it would have traded away behaviour every terminal has, to shave a
number that already matches every terminal.

### What actually reproduces it

Claude Code repaints **differentially**: in a captured session, 25 363
cursor-moves against 3 030 line-erases, no `ESC[2J`, no `ESC[0J`, no alternate
screen. It patches the cells it believes changed, and it erases with `ESC[2K`
one line at a time — so it erases exactly as many rows as *it* wrapped its text
into. It wraps to `process.stdout.columns`, which is the pty's winsize.

The emulator wraps at the grid's width. If those two numbers differ, every line
the program thinks is one row is two, its erase falls short by the difference,
and the top of the old frame is left behind. That row then scrolls off, where no
cursor-up can ever reach it again — which is exactly why the damage is only ever
visible in lines that are off screen.

This needs no resize at all. Same harness, real Claude Code, nothing resized at
any point — only a pty and a grid that were started at different widths:

| grid vs pty | buffer lines | extra copies |
| --- | --- | --- |
| 120 == 120 | 30 (the screen, nothing below) | **0** |
| 100 < 120 | 38 | **2** |

And it does not decay: forty forced repaints leave the same two copies as
twelve. A disagreement is not a glitch that washes out, it is a steady state
that strands a copy every time the frame's height changes — every turn, for as
long as the session lives.

### Why nothing puts it right

Both halves of manor assume the other one is fine, and the assumption is load-bearing:

- **`useTerminalResize.sendFit`** returns early when `proposeDimensions()`
  matches `term.cols`/`term.rows`. That is a test against the *grid*, used as a
  proxy for the pty. After ADR-164 the grid is driven by the daemon, so the
  proxy is usually sound — and when it is not, this early return is what makes
  the disagreement permanent, because the one thing that would fix it is the
  send being skipped.
- **`Session.resize`** returns early when the requested size matches the
  session's — *without broadcasting anything*. A client whose grid has drifted
  asks for the size it should already have and is told nothing at all.

Together those two are a latch. Once the grid and the winsize part company,
every subsequent request to fix it is dropped on one side or the other, and the
session stays wrong until something happens to move it to a genuinely new size.

There is a third, unreachable today but on the same theme: `TerminalHost.create`
returns an existing session's `info` and ignores the `cols`/`rows` it was
handed. Nothing hits it because `client.doCreateOrAttach` sends an explicit
`resize` before it subscribes — but that is one call site's good manners
standing in for an invariant, and it should not be.

## Decision

**Every resize request produces a `resized` event, and the renderer decides
whether to send from what it last sent rather than from its grid.** Neither
side gets to conclude, from its own state, that the other side already agrees.

1. **`Session.resize` always publishes.** When the requested size matches the
   session's, skip the ioctl — the program must not be made to repaint for
   nothing — but still broadcast `resized` with the current size. It is a no-op
   for every client that already agrees (`resizeInStream` returns without
   touching the terminal) and it is the repair for any client that does not.

2. **`useTerminalResize` sends when the measurement differs from the last size
   it sent**, not from `term.cols`/`term.rows`. The grid is no longer treated as
   a stand-in for the winsize, which is the whole point of ADR-164 — the grid
   follows the daemon, so it cannot also be the evidence for what the daemon
   knows.

Those two compose into the invariant the app has been missing: a drifted grid is
corrected at the next settle, from whatever cause, without anything having to
diagnose the cause.

3. **`TerminalHost.create` reconciles an existing session** to the `cols`/`rows`
   it was called with, so the invariant does not depend on one caller's ordering.

4. **`Session.applyResized` publishes at the marker, and at the size that was
   acknowledged.** Two defects in ADR-164's publishing half, both measured as
   quiet today and both able to open the disagreement this ADR then has to
   repair. The `resized` event is emitted from inside `headless.write("", cb)`,
   so it goes out behind the mirror's parse backlog while every `data` event is
   broadcast the instant its frame is decoded; and it publishes `this.cols` /
   `this.rows` — already the newest size asked for — rather than the size the
   arriving ack belongs to, so with two resizes in flight the first ack
   publishes the second one's size.

5. **`TERMINAL_HOST_PROTOCOL` goes to 4.** No wire *shape* changed — the number
   carries "this daemon cannot serve this client correctly", and a protocol-3
   daemon stays silent for exactly the request that needs an answer. A daemon
   outlives the app that spawned it and is otherwise only replaced when the app
   *version* differs, so without this the fix ships and sits inert in a running
   dev app, which is the failure `isDaemonStale` was written for after ADR-159.

### Not doing

**Disabling reflow.** It was measured (7 stranded copies per drag → 1) and
rejected: rewrapping on resize is what a terminal does, and the measurement was
against `fake-tui.sh`, which repaints in full with `ESC[0J` and is not how the
program that actually breaks behaves. Reflow is a real second-order contributor
— it is one of the ways the grid's row arithmetic can move under a program — but
it is not what makes the duplication permanent, and it is not worth its cost.

## Consequences

**Better**

- A grid and a winsize that disagree get one settle to be wrong, instead of the
  rest of the session. That is the difference between a flicker and issue #169.
- The repair is causeless: it does not matter whether the drift came from a lost
  event, an ack timeout, a remount, or a client we have not written yet.
- `sendFit` stops carrying an assumption it cannot check.

**Harder / riskier**

- The protocol bump replaces a running daemon, ending live sessions — the same
  cost ADR-159, ADR-163 and ADR-164 carried. Protocol 3 is itself unreleased,
  so in a released build this is invisible: the version check fires first.
- A redundant `resized` on the wire per no-op resize request. It costs one JSON
  line, it is rate-limited by `SETTLE_MS`, and it deliberately does *not* reach
  the pty, so no program is made to repaint for it.
- `TerminalHost.create` now has a side effect on an existing session. It does
  not await the ioctl acknowledgement — `Session.resize` records the size and
  writes towards the subprocess synchronously, so `info` already reports what
  the caller asked for, and nothing here needs the ack.
- The invariant is only as good as the renderer measuring correctly in the first
  place. If `proposeDimensions()` oscillates across a grid change — the refit
  loop `useTerminalResize` runs on `term.onResize` — this makes the oscillation
  *visible* as repeated pty resizes rather than fixing it. That is the next
  thing to measure if #169 survives this, and it can only be measured in the
  real renderer.

**Unchanged**

- ADR-164 entire: the daemon marks where in the stream the ioctl landed, and
  clients apply the resize there.
- ADR-163's daemon half: the flush before the ioctl, the `RESIZED` frame after
  it, `Session.resize` resolving on that frame.
- Reflow.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
