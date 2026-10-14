---
title: A non-clean drop becomes unreachable after a grace period
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# A non-clean drop becomes unreachable after a grace period

ADR-230 D5 (gap R1).

## What to build

- **`WsTransport.onClose`** (`src/bridge/transports/ws.ts:483-512`):
  - Listed unreachable codes (`pipe.unreachableCodes`) still report at
    once.
  - Any other close that leads to a redial starts a grace timer,
    `DROP_GRACE_MS = 4000`, exported for tests. When it fires,
    `options.onStatus?.("unreachable")`.
  - Clear the timer on `onReady` (hello), `close()`, the 4401 and
    key-mismatch stops, and a listed-code close that already reported.
  - Don't start a second timer while one is pending.
- **Desktop host pipes are unaffected.** They already end every pipe with
  `CLOSE_HOST_UNREACHABLE` (`src/bridge/transports/host-pipe.ts:12-15,38`).
  Confirm this with a test or a comment.
- **Check `install-web.ts`'s status handling.** `onStatus("unreachable")` sets
  `needsResync` (:423), and the next hello must set `"connected"` again.
  `FIRST_HELLO_DEADLINE_MS` (:112-122, :431-437) is the pattern to follow;
  don't double-report.

## Tests (each must fail on the base commit)

- `src/bridge/__tests__/relay-pipe.test.ts:541`, "does not call an ordinary
  drop unreachable". Rewrite it as: after `drop(1006)` there is no
  unreachable before `DROP_GRACE_MS`, and unreachable after it (fake
  timers).
- `src/bridge/__tests__/ws.test.ts`, in the "reconnecting" describe (:455):
  - a hello within the grace period means no unreachable;
  - `close()` within the grace period means no unreachable.
- `src/bridge/__tests__/install-web-relay.test.ts`. After
  `FakeRelaySocket.drop()` and the grace period:
  - `servers.facts(BOX).reachability === "unreachable"`;
  - after the next hello it is `"connected"`.
- `src/bridge/__tests__/router.test.ts`: a call for a host whose server has
  just gone unreachable goes to a desktop that lists the host. Reuse
  `set.setReachability` as at :583/:612. The router tests may already cover
  this; then add only what the transport change needs.

## Files to touch
- `src/bridge/transports/ws.ts`
- `src/bridge/install-web.ts`, only if needed
- Tests named above.
