---
title: port-pipe carries half-close both ways
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# port-pipe carries half-close both ways

ADR-230 D4 (gap L4).

## What to build

- **Box** (`electron/terminal-host/port-pipe.ts:65-103`):
  - Stop using the shared `pump` and `teardown` from `bridge.ts`. They stay
    as they are for the other bridges.
  - `connect()` uses `net.createConnection({ port, host, allowHalfOpen: true })`.
  - A local pump:
    - `io.stdin.pipe(socket)` and `socket.pipe(io.stdout)`, both with
      `end: true`;
    - resolve when stdin has ended (or errored) and the socket has emitted
      `end` or `close` (or errored);
    - destroy both on an error from either side.
  - **Linger.** Once one direction has ended, if 5 min pass with no data
    from the other direction, destroy and resolve. Make the time an
    injectable option for tests.
- **Desktop**
  (`electron/backend/providers/command-provider.ts:170, 205-247`):
  - `net.createServer({ allowHalfOpen: true }, …)`;
  - keep `socket.pipe(stdin)`, `stdout.pipe(socket)`, `child close →
    socket.end()` and `socket close → kill`;
  - make sure a write-after-end error is no longer swallowed silently in a
    way that hides real failures.

## Tests (each must fail on the base commit)

- `electron/terminal-host/__tests__/port-pipe.test.ts`:
  - a real `net` server that replies only after it receives `end`, and
    then closes. Stdin ends; the reply still reaches stdout.
  - the reverse: the server ends first, and stdin data written afterwards
    still reaches the server.
  - the linger timeout with a tiny injected value.
- `electron/backend/__tests__/command-provider.test.ts`: a client
  `socket.end()` after sending, and the reply still arrives through the
  `FakePipeChild` (the existing test at :208 shows the pattern).

## Files to touch
- `electron/terminal-host/port-pipe.ts`
- `electron/backend/providers/command-provider.ts`
- Tests named above.
