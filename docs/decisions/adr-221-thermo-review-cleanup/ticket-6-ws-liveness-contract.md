---
title: WS transport liveness contract and single probeNow
status: todo
priority: high
assignee: opus
blocked_by: []
---

# WS transport liveness contract and single probeNow

`src/bridge/transports/ws.ts`:
- `probe?`/`close?` on `PipeConnection` (~66-71) are one capability split into two optionals; the fake adds them as a pair (`...(probe && { probe, close })`).
- A failed probe sets `redialImmediately = true` (~203, 275-282, 432-466); if a pipe had `probe` without `close`, the flag lingers and a later unrelated close skips backoff. `probe()` repeats optional checks already done in `probeNow` (~259, 275, 282). `onClose` gains a one-off immediate mode.
- Three public entry points: `retryNow`, `checkNow` (just `void this.probeNow()`), `probeNow`. `probeNow` returns `"redialing"` when `stopped` or token is null (~242-244) — false.
- `src/bridge/install-web.ts:124,149-150` keeps `helloCount` to re-derive "is this a reconnect", which the transport knows (it sends `previousId` iff `rendererId !== null`).

Do:
1. Make `probe` and `close` required on `PipeConnection`; relay-pipe already has both; test fakes default `probe` to resolve `true`.
2. Delete `redialImmediately`. On failed probe: detach the socket (`++generation` so its late `onClose` is ignored), `socket.close()`, run a shared `teardown()` (reject pending, clear outbox, `ready=false` — extracted from `onClose`), then `attempt = 0; open()`. `onClose` has one backoff path.
3. Public API: only `probeNow(): Promise<"alive" | "redialing" | "stopped">`. Delete `checkNow` and `retryNow`. `retryBridgeNow` and foreground listeners in `install-web.ts` call `void transport.probeNow()`. (Tapping "try again" now also resets backoff and dials when socketless — intended.) Update any UI callers (grep `retryNow`, `checkNow`, `retryBridgeNow`).
4. Replace `helloCount` with the transport exposing whether the hello was a resume (e.g. the hello handler receives `resumed: boolean` computed from `previousId` being sent). Keep wire protocol unchanged unless trivially safe.
5. Update `src/bridge/__tests__/ws.test.ts`, `relay-pipe.test.ts`, `install-web-relay.test.ts`; keep the stale-probe and burst-of-probes cases.

## Files to touch
- `src/bridge/transports/ws.ts`
- `src/bridge/transports/relay-pipe.ts`
- `src/bridge/install-web.ts`
- `src/bridge/__tests__/ws.test.ts`, `relay-pipe.test.ts`, `install-web-relay.test.ts`
