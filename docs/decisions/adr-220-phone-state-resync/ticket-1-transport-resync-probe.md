---
title: Resync signal, transport probe and foreground checks
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Resync signal, transport probe and foreground checks

Implement ADR-220 D1, D4 and the `refreshBridge` export from D5.

1. **`src/bridge/resync.ts`** (new)
   - Export `onBridgeResync(cb)`, which returns an unsubscribe function, and `emitBridgeResync()`.
   - Iterate over a copy of the listener set. Wrap each callback in try/catch and `console.error` on failure.

2. **`src/bridge/transports/ws.ts`**
   - Add two optional members to `PipeConnection`:
     - `probe?(timeoutMs: number): Promise<boolean>`
     - `close?(): void`. It must report through `onClose` exactly once, with an unreachable code.
   - Add `checkNow(): void` to `WsBridgeTransport` and `WsTransport`:
     - If stopped: return.
     - If a reconnect timer is pending: clear it, set `attempt = 0`, then `open()`.
     - Else if there is no socket: `open()`.
     - Else if ready and `socket.probe` exists: await `probe(PROBE_TIMEOUT_MS)`, with `PROBE_TIMEOUT_MS = 2_000` exported. If it returns false and the socket is still the same one (check the generation), set a flag `redialImmediately = true` and call `socket.close?.()`.
     - Concurrent `checkNow` calls must not stack probes. Keep an in-flight promise.
   - In `onClose`, if `redialImmediately` is set: clear it, set `attempt = 0`, and dial with delay 0. Still report `onStatus` as usual.
   - Expose a `probeNow(): Promise<"alive" | "redialing">` that `refreshBridge` uses. It returns `"alive"` when the probe passes, and otherwise behaves like a failed `checkNow`.

3. **`src/bridge/transports/relay-pipe.ts`**
   - Implement `probe`:
     - If not open, resolve false.
     - Otherwise send `HEARTBEAT_PING` and resolve true on the next inbound message of any kind (hook into `socket.onmessage`), or false after `timeoutMs`.
     - Clean up the timer and the waiter on close.
   - Implement `close` as `fail(CLOSE_RELAY_UNREACHABLE)`.
   - Do not interfere with the `awaitingPong` heartbeat logic.

4. **`src/bridge/install-web.ts`**
   - Track `let helloCount = 0`. In `onHello`, increment it after the version-redirect check. If it is now > 1, call `emitBridgeResync()`.
   - Replace the `online` and `visibilitychange` listeners with calls to `transport.checkNow()`. Add a `pageshow` listener that calls it too.
   - Keep `retryBridgeNow`.
   - Export `refreshBridge(): Promise<void>`. It calls `transport.probeNow()`, and on `"alive"` calls `emitBridgeResync()`. On `"redialing"` the hello path emits the resync, so do nothing more.

5. **Unit tests**
   - Find the existing tests for ws.ts and relay-pipe.ts (`src/bridge/**/__tests__` or colocated) and extend them. Cover:
     - `checkNow` with a pending timer resets the backoff.
     - A failed probe closes the socket and redials with no delay.
     - A passing probe leaves the socket alone.
     - The second hello emits a resync and the first does not. Test this through a fake pipe, or by unit-testing a small helper if install-web is hard to import.
     - `resync.ts` isolates a listener that throws.

## Files to touch
- `src/bridge/resync.ts` — new
- `src/bridge/transports/ws.ts` — `checkNow`, `probeNow`, immediate redial, optional pipe methods
- `src/bridge/transports/relay-pipe.ts` — `probe` and `close`
- `src/bridge/install-web.ts` — emit on re-hello, foreground triggers, `refreshBridge`
- tests next to the above
