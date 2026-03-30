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

# ADR-090: Fix PTY daemon hang causing all terminals to become unresponsive

## Context

When a terminal pane fails to create/attach a PTY session, ALL terminals become unresponsive. Two error patterns are observed:

1. `Create failed: unknown` — the daemon responds with an unexpected response type
2. `Request timed out: create` — the daemon never responds

Root cause analysis reveals two interrelated bugs in the terminal host daemon:

### Bug 1: `flushHeadless()` can hang forever

In `session.ts`, `Session.getSnapshot()` calls `flushHeadless()` which waits for `headlessWritesPending` to reach 0. If the headless terminal's write callback never fires (xterm bug, disposed terminal, etc.), the promise never resolves. Since the daemon uses a `createSerializedHandler` queue (index.ts:246-255) to maintain response ordering, a hung handler blocks ALL subsequent control messages on that socket — making every terminal unresponsive.

### Bug 2: Client response queue mismatch after timeout

When a client request times out (10s), the client removes the pending entry but stays connected. When the daemon eventually sends the late response, it gets matched to the NEXT pending request (FIFO mismatch). This causes terminals to enter invalid states — e.g., warm restore for non-existent sessions (terminal renders stale data with no PTY backing it, appearing "alive" but not accepting input).

### Bug 3: Daemon handler exceptions swallowed without response

If `handleControlMessage` throws an unhandled exception, the `createSerializedHandler` catch logs it but sends no response. The client's pending request times out, and the same FIFO mismatch from Bug 2 can cascade.

## Decision

Three targeted fixes:

### Fix 1: Timeout `flushHeadless()` (session.ts)

Add a 2-second timeout to `flushHeadless()`. If pending writes don't complete in time, resolve anyway (serialize will return whatever state the headless terminal has). This prevents the daemon handler queue from stalling.

### Fix 2: Disconnect on client request timeout (client.ts)

When a request times out, call `cleanup()` to disconnect the control and stream sockets. The next request will trigger `ensureConnected()` → `connect()` which reconnects cleanly. This prevents stale responses from being matched to wrong requests.

### Fix 3: Catch-all error response in daemon (index.ts)

Wrap each `handleControlMessage` call in the serialized handler with a try/catch that sends `{ type: "error", message: "Internal error: ..." }` if the handler throws. This ensures the client always gets a response and the FIFO queue stays in sync.

## Consequences

- **Fixes**: All terminals becoming unresponsive when one PTY creation fails
- **Tradeoff**: `flushHeadless` timeout means snapshots may occasionally be incomplete (missing the last few ms of output), but this is far better than hanging forever
- **Risk**: Disconnecting on timeout forces reconnection, which is slightly heavier than just removing the pending request — but correctness is more important than avoiding a reconnect

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
