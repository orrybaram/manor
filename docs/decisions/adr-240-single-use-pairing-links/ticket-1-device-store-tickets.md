---
title: Device store - pending devices, tickets, redeem, reissue, direct pair
status: todo
priority: critical
assignee: sonnet
blocked_by: []
---

# Device store: pending devices, tickets, redeem, reissue, direct pair

Implement ADR-240 D2, D3 and D4 in the device store. Read the ADR (`index.md` in this folder) first.

- `RemoteDevice.tokenHash: string | null`; `RemoteDevice.pending?: { ticketHash: string; expiresAt: number }`, present exactly when `tokenHash` is null. Serialize `tokenHash: null` as-is.
- `KNOWN_FIELDS` gains `"pending"`. `asDevice` (currently requires a 64-hex `tokenHash`, :629) accepts a 64-hex `tokenHash`, or null/absent `tokenHash` with `pending = { ticketHash: 64-hex, expiresAt: number }`; anything else is dropped. Keep expired pending rows on load.
- `TICKET_BYTES = 32`, `PAIRING_TICKET_TTL_MS = 10 * 60_000`; constructor option `ticketTtlMs`, defaulting to env `MANOR_PAIRING_TICKET_TTL_MS` when it is a positive integer, read once.
- `pair(label, relayRoom, options?: { direct?: boolean })` returns `{ device, ticket, expiresAt }` by default (pending row), `{ device, rawToken }` with `direct: true` (today's behaviour). Persist + `await flush`, rollback on failure, as today. Type the return as a discriminated overload or union that callers can narrow.
- `reissue(id)` → `{ device, ticket, expiresAt }` for a pending row (waiting or expired): new ticket, new `expiresAt`, persist + flush, rollback on failure. Throws `new Error("Only a device that has not connected yet can get a new link.")` for an active or unknown id.
- `redeem(ticket: unknown, token: unknown): RemoteDevice | null`, **synchronous**. Both must be strings; token must match `/^[A-Za-z0-9_-]{43}$/` (export it as `TOKEN_PATTERN`). Hash the ticket and compare against every pending row's `ticketHash` with `timingSafeEqual` without short-circuiting (mirror `verify`). On a match: `expiresAt < now` → null (row kept); `sha256(token)` equals some device's `tokenHash` → null; else set `tokenHash`, delete `pending`, `lastSeenAt = now`, call `persist()` inside try/catch — a synchronous throw rolls the row back and returns null. Return the device.
- `verify(rawToken)` skips rows whose `tokenHash` is null.
- `publicView` adds `pending: { expiresAt }` when present; never the hash. `RemoteDeviceInfo` type gains `pending?: { expiresAt: number }`.
- Update the file header's load-bearing properties: the store never holds a raw token; a ticket exists once, in `pair()`/`reissue()`'s return; a token only in the redeeming hello.

## Files to touch
- `electron/remote-control/devices.ts` — everything above.
- `electron/remote-control/__tests__/devices.test.ts` — new cases: pair mints a pending row whose ticket does not `verify()`; `redeem(ticket, token)` activates it and the token verifies after; a second `redeem` with the same ticket returns null; redeem after `expiresAt` returns null and the row stays pending; malformed token and a token whose hash already exists are rejected; `reissue` replaces the ticket (old dead) and throws for active/unknown; `verify` never matches a ticket; a write failure in `redeem` rolls back; a pending row round-trips through the file; a row with neither `tokenHash` nor valid `pending` is dropped; `pair(..., {direct:true})` behaves as before; `list()` exposes `pending.expiresAt` and never the ticket hash; TTL from `ticketTtlMs`. Existing tests reading `rawToken` from `pair` switch to `{ direct: true }` or redeem.
- `electron/remote-control/__tests__/push.test.ts` and any other test calling `devices.pair` — keep compiling (switch to `{ direct: true }` where they need a token).

Acceptance: `pnpm typecheck`, `pnpm vitest run electron/remote-control`.
