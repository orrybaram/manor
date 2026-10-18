---
title: Docs - remote-control.md and CONTEXT.md
status: todo
priority: high
assignee: sonnet
blocked_by: [2, 4]
---

# Docs: remote-control.md and CONTEXT.md

Bring the user docs and glossary in line with ADR-240 (`index.md` in this folder). Do not edit anything under `docs/decisions/`. Match the existing plain, blunt style.

- `docs/remote-control.md`:
  - "A token per device" (~:75-79): pairing issues a single-use ticket that expires in 10 minutes; the device chooses its own token and sends it with the ticket in its first hello; Manor stores only its hash; the token never appears in a link, QR code or reply.
  - "To use it" link example (~:110): `#relay=<room>.<key>&ticket=<ticket>`.
  - "Pairing a device" (~:179-192) steps 2-3: the link works once and for 10 minutes; New link on the device's row; the browser keeps the token it chose.
  - LOCAL_ONLY list (~:42-51): add `reissue` beside `pair`/`revoke`.
  - "What the relay can and cannot see": cannot see the ticket either.
  - Under "If a token leaks", a short "If a link leaks" paragraph: once opened or expired it is useless; if your own browser says it is not paired but the row says last seen, someone else opened it first — revoke the device.
  - "Pairing a phone with a host": `hosts.pairDevice` returns a ticket link; the pairings the desktop mints for a device on each host are direct tokens handed over inside the device's encrypted channel.
  - "Where things live": `remote-devices.enc` also holds pending devices (a ticket hash and its expiry).
- `CONTEXT.md`: new term **Pairing ticket** next to **Paired device**: what is in a pairing link — single use, 10 minutes, redeemed by the device's first hello, which carries a token the device chose. _Avoid_: pairing token, invite code, pairing code. Amend **Paired device** and any relationship line that says the link carries the token.

## Files to touch
- `docs/remote-control.md`
- `CONTEXT.md`

Acceptance: terms consistent with CONTEXT.md; `pnpm lint` still passes.
