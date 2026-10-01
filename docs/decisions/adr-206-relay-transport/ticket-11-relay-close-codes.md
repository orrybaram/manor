---
title: Pass bridge close codes through the relay
status: done
priority: high
assignee: opus
blocked_by: [2, 4, 5]
---

# Pass bridge close codes through the relay

Found while implementing ticket 4. `OP_CLOSE` carries no close code and the
room closes the viewer with 1000, so when the bridge rejects a `hello` with
4401 (revoked or unknown token) or 4403 (tier below `full`), the browser sees
a plain close and keeps reconnecting instead of showing the pairing or
Forbidden screen.

## What to build

- `OP_CLOSE` from the host may carry an optional 2-byte big-endian close code
  after the channel. The room passes it through to the viewer only if it is in
  an allow-list (4401, 4403); anything else, or no code, closes 1000 as today.
  Old hosts (3-byte `OP_CLOSE`) keep working.
- `RelayChannel.close(code, reason)` sends the code.
- The browser `relay-pipe.ts` surfaces 4401/4403 exactly like the listener
  `Pipe` does, so the existing NoToken / Forbidden handling applies.

The code is metadata the relay already learns (the channel closed); it adds
no plaintext to what the relay sees.

## Files to touch
- `src/lib/relay-crypto/protocol.ts`, `relay/src/room.ts`, `relay/test/*`
- `electron/remote-control/relay/{channel,connector}.ts` + tests and fake relay
- `src/bridge/transports/relay-pipe.ts`, `src/bridge/__tests__/fake-relay.ts` + tests
