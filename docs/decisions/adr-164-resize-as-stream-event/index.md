---
type: adr
status: accepted
supersedes: adr-163
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

# ADR-164: A resize is a position in the output stream

Supersedes the decision in [ADR-163](../adr-163-resize-grid-winsize-ordering/index.md).
Its diagnosis of the failure — a repainting program strands a copy whenever the
grid disagrees with the winsize it was last told — still holds, and its daemon
half (the pty acknowledges a resize only once the ioctl has landed) is what
makes this ADR possible. What it got wrong is the thing it asked the renderer
to do with that acknowledgement.

## Context

### What a local terminal does

A resize in ghostty, iTerm2 or Terminal.app is one function on one thread: set
the grid, call `TIOCSWINSZ`. It happens between two reads of the pty. Bytes
read before it were applied to the old grid; bytes read after land on the new
one. The resize is not an event that races the output — it is **a position in
the output**, and that is the whole reason a repainting program cannot be
stranded by it. The program's `SIGWINCH` and the emulator's reflow refer to the
same instant in the same byte stream.

### What manor does instead

manor split that atom across a process boundary and kept one half. The renderer
owns the geometry, so it decides the size and resizes its grid locally and
immediately. The winsize change travels renderer → main → daemon → pty
subprocess → ioctl. Output produced in that window is applied to a grid that
does not match what the program believes, and an inline agent harness — which
repaints a region by moving the cursor up over the rows it last drew — strands
a copy every time it repaints across the gap.

ADR-163 read this as an *ordering* problem and gave the renderer a rule about
which of the two to move first, plus a set of timers to decide when. Measured
against real drags, captured through a renderer-side trace and replayed offline
into a headless emulator, each rule leaked somewhere else:

| policy | grid moves | pty moves | copies stranded |
| --- | --- | --- | --- |
| ratchet the grid, hand the pty the settled size (ADR-163) | 144 | 36 | 142 |
| move both together, pty first, on every frame | 236 | 1025 | 2296 |

The second run is the instructive one. Making the resize an acknowledged RPC
and moving the grid the moment it resolved — 1-2ms, measured — was *ten times
worse per grid move*, because 1-2ms is still long enough for a streaming
program to draw a line at the new width into a grid still at the old one.

That is the shape of the whole problem: every rule in ADR-163 is a guess at
**where in the byte stream the winsize changed**, and a promise resolving
cannot answer that question. It reports a moment in wall-clock time. The answer
is a position among the bytes.

### The mechanism already exists

The daemon already treats a resize as a stream position for its own headless
mirror, and did before ADR-163:

- `pty-subprocess.ts` flushes its batched output *before* the ioctl and only
  then writes the `RESIZED` frame, so no pre-resize byte can follow that frame
  on the wire.
- `Session.resizeMirror` applies the mirror's resize via
  `headless.write("", () => headless.resize(...))`, which lands it behind
  whatever writes are already queued — at that position, not at that moment.

The daemon's emulator therefore never strands. The renderer's does, because the
renderer was handed a promise where the daemon kept a marker.

## Decision

**The daemon tells every attached client where in the stream the size changed,
and clients apply it there.**

`StreamEvent` gains `{ type: "resized"; sessionId; cols; rows }`, broadcast on
the same ordered channel as `data`, at the point `MSG.RESIZED` arrives — which
the subprocess already guarantees follows every pre-resize byte.

`useTerminalStream` applies it the way the daemon mirror does:

```ts
term.write("", () => term.resize(cols, rows));
```

so the grid changes at its true position among the writes.

`useTerminalResize` is then only geometry: measure the container, coalesce for
cost, send the desired size. It does not resize the terminal at all.

`TERMINAL_HOST_PROTOCOL` goes to 3, because a protocol-2 daemon never sends the
event and a client that waits for one would never resize its grid.

### What this deletes

Everything ADR-163 added to the renderer to manage a gap that no longer exists:

- `src/lib/terminal-grid.ts` and `growToward` — the ratchet
- `SETTLE_MS` as a correctness device (a debounce stays, purely to spare the
  program a full re-render per animation frame)
- `REDRAW_GRACE_MS`, `REDRAW_QUIET_MS` and `awaitRedraw` in `useTerminalStream`
- the direction-ordered union dance and the re-measure loop in `handOff`
- the "grid is never smaller than the pty" invariant itself, which was a proxy
  for stream ordering and is not needed once the ordering is exact

## Consequences

**Better**

- The grid and the program's belief change at the same point in the same byte
  stream, which is what a local terminal does and why one does not strand.
- Correct for *every* attached client at once. A phone attached to the same
  session applies the same resize at the same position instead of guessing
  independently — a case no renderer-side heuristic could reach.
- `useTerminalResize` stops being a state machine. Measure, debounce, send.

**Harder / riskier**

- The grid now lags the container by a round trip (~2-5ms plus a debounce), so
  a drag shows the pane's old geometry briefly. This is the same transient
  ADR-163 accepted, in a narrower form: the pane is never clipped for a settle
  window, only for the round trip.
- A daemon that stops answering leaves the grid at its old size. ADR-163's
  ack timeout still applies and resolves the resize, so the event is still
  broadcast; the failure mode is a stale grid rather than a wrong one.
- The protocol bump replaces a running daemon, ending live sessions — the same
  cost ADR-159 and ADR-163 carried.
- Reflow still happens on every width change; that is unavoidable and is what
  every terminal does. What changes is that the program's idea of the width and
  the grid's reflow now refer to the same instant.

**Kept from ADR-163**

- The pty subprocess's `RESIZED` frame after the ioctl, and its flush before it.
- `Session.resize` resolving on that frame, and the mirror resizing behind its
  own write queue.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
