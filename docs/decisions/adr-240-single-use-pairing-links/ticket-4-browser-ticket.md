---
title: Browser - ticket links, self-chosen token, ticket in hello
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Browser: ticket links, self-chosen token, ticket in hello

Implement ADR-240 D5. Read `index.md` in this folder. The protocol is fixed by the ADR, so this runs independently of the desktop tickets.

- `src/bridge/pairings.ts`: `StoredPairing.ticket?: string`, accepted by `isStoredPairing`; `TicketLink { roomId; serverKey; ticket }`; `upsertTicketPairing(link, now?, mintToken = freshDeviceToken)`: if the room's stored pairing has `ticket === link.ticket`, bump `lastUsedAt`, undecline, keep its token; else store `{ ...existing, serverKey, token: mintToken(), ticket: link.ticket, lastUsedAt: now }` (same naming defaults as `upsertPairing`). `clearPairingTicket(roomId, ticket)` deletes the field only while it still matches. `freshDeviceToken()` uses `base64urlEncode` from `src/lib/relay-crypto` over 32 bytes of `crypto.getRandomValues` (43 chars).
- `src/bridge/web-pairing.ts`: `parseFragment` returns `{ kind: "ticket", link: TicketLink }` for `relay=…&ticket=…`; both `t` and `ticket` → `invalid`; `readPairing` routes a ticket to `upsertTicketPairing` and strips the fragment. Update the header (link forms). `TOKEN_PATTERN` unchanged.
- `src/bridge/transports/ws.ts`: `WsTransportOptions.ticket?: string | null`; `sayHello` adds `ticket` while held; clear it on the first accepted hello in `onFrame` so reconnects never send it.
- `src/bridge/install-web.ts`: `open()` passes `ticket: pairing.ticket ?? null`; `onHello` calls `clearPairingTicket(roomId, entry.pairing.ticket)` before `recordPairingHello`. Confirm `syncPairings` (:493-522) does not redial — the token does not change, so it should take the `entry.pairing = pairing` branch; keep it that way. Update header bullets.

## Files to touch
- The four source files above.
- `src/bridge/__tests__/web-pairing.test.ts` — parse `ticket=`; both → invalid; `readPairing` on a ticket link stores a 43-char token plus the ticket and strips the fragment; the same ticket on a second load keeps the token; a `t=` link still works.
- `src/bridge/__tests__/pairings.test.ts` — `upsertTicketPairing` idempotent per ticket, a new ticket → new token, `clearPairingTicket` only when matching, `isStoredPairing` accepts `ticket`.
- `src/bridge/__tests__/ws.test.ts` — hello carries token and ticket; ticket not sent after the first accepted hello; reconnect hello has `previousId` and no ticket.
- `src/bridge/__tests__/install-web-relay.test.ts` — dials with the generated token and the link's ticket; the accepted hello clears the ticket from storage without redialling (one `FakeRelaySocket`).

Acceptance: `pnpm typecheck`, `pnpm vitest run src/bridge`.
