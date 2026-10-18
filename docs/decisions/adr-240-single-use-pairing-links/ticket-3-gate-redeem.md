---
title: Relay gate - redeem a ticket on hello
status: todo
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Relay gate: redeem a ticket on hello

Implement ADR-240 D1's server side. Read `index.md` in this folder.

- `electron/remote-control/relay-gate.ts`: `DeviceVerifier` gains `redeem(ticket: unknown, token: unknown): AuthenticatedDevice | null`; `attach` passes the hello through (`(token, hello) => this.authenticate(token, hello)`); `authenticate(token, hello?)`: `verify(token)` first; if null and `hello?.ticket` is a string, `redeem(hello.ticket, token)`; if both null, the existing backoff path and 4401 (a failed ticket counts as a failure). On a redeem, log `[remote-control] pairing link redeemed by "<label>"` — never the ticket. Header doc: verify, then redeem, then backoff.
- `electron/bridge/transports/ws.ts`: header and `BridgeAuthenticator` doc (:77-87) — the hello may carry `ticket` beside `token`. Make sure the `hello` frame object reaches the authenticator (it already passes `frame`; confirm). No logic change.
- `electron/bridge/types.ts`: `HelloReplyFrame` doc notes it carries no credential on purpose (ADR-240: the device chose its token).

## Files to touch
- `electron/remote-control/relay-gate.ts`, `electron/bridge/transports/ws.ts`, `electron/bridge/types.ts`.
- `electron/remote-control/__tests__/relay-gate.test.ts` — fake verifier gains `redeem`; cases: ticket + token admits and returns the device; a valid token verifies first and `redeem` is not called; ticket with a bad token refused; a failed ticket counts toward backoff; a valid token while backed off still admits.
- `electron/remote-control/__tests__/ws-bridge.test.ts` — fake verifier gains `redeem`; "redeems a ticket on the first hello and the reply is an ordinary hello"; "a spent ticket closes 4401".

Acceptance: `pnpm typecheck`, `pnpm vitest run electron/remote-control`.
