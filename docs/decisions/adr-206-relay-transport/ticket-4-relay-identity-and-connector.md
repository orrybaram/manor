---
title: Relay identity and the host connector
status: done
priority: critical
assignee: opus
blocked_by: [1, 2, 3]
---

# Relay identity and the host connector

ADR-206 D3, D5. The desktop dials the relay, authenticates its room, and turns
each viewer channel into a `FrameSocket` for the bridge.

## What to build

- **`electron/remote-control/relay/identity.ts`** — `RelayIdentityStore`:
  load or create (`generateRelayIdentity()` from ticket 1) and persist through
  `safeStorage` to `remote-relay-identity.enc` in `manorDataDir()` (add the
  path helper to `electron/paths.ts`), mode 0600. Throws
  `EncryptionUnavailableError` (reuse from `devices.ts`) rather than writing
  plaintext. `reset()` regenerates. Exposes `roomId` and `x25519Pub` (base64url).
- **`electron/remote-control/relay/connector.ts`** — `RelayConnector`:
  - `start()`: dial `wss://<relayUrl>/host/<roomId>` with `ws`; answer the
    challenge via `signHostChallenge`; status `starting` → `running` on
    `{t:"ok"}`. `stop()` closes and drops all channels. Status shape mirrors
    `TunnelStatus` (`state`, `url` = relay origin, `error`), with `onStatus`.
  - Reconnect on unexpected close with capped backoff 1 s → 30 s; 4409
    (replaced by another host with this key) → `failed` with a clear message,
    no reconnect.
  - Per `OP_OPEN`: a `RelayChannel` that runs `createResponder` with the
    identity's X25519 key. Handshake must finish within 5 s or the channel is
    closed. After the handshake it implements `FrameSocket`
    (ticket 3): `send(text)` → `sealFrame` → enqueue; incoming data →
    `openFrame` → `onMessage`. Any decrypt failure closes the channel
    (`OP_CLOSE`), never retries.
  - **Coalescing:** outgoing sealed chunks for a channel are batched into one
    relay message, flushed every 16 ms or at 64 KiB. Length-prefix each
    chunk inside the batch (u32) so the browser can split it; the browser
    side (ticket 5) must agree — define the batch format in
    `src/lib/relay-crypto/channel.ts` (`packBatch` / `unpackBatch`) so both
    ends import it.
  - Each `RelayChannel` is passed to `wsBridge.attach(channel, auth)`, where
    `auth` is `RemoteControlServer`'s `authenticateBridge` with source
    `"relay"` — expose it as a public method (`authenticateRelayHello`) rather
    than duplicating the verify/backoff/tier logic.
- **Relay URL:** `MANOR_RELAY_URL` env overrides a constant default in
  `relay/connector.ts` (`DEFAULT_RELAY_URL`, placeholder until the domain is
  chosen — leave a `TODO(adr-206)` naming it).
- Wire construction in `electron/app-lifecycle.ts` next to `wsBridge`;
  nothing starts it (ticket 7 does).

## Tests

`electron/remote-control/relay/__tests__/`: run the connector against an
in-process fake relay (a `ws` server implementing the ticket-2 protocol) and a
fake viewer that uses the ticket-1 initiator: auth, open channel, handshake,
`hello` with a valid `full` token reaches the bridge and an invoke round-trips;
bad token → channel closed 4401 path; tampered ciphertext closes the channel;
host replaced → `failed`; reconnect after drop. Identity store: round trip,
refuses without encryption, reset changes room id.

## Files to touch
- `electron/remote-control/relay/{identity,connector,channel}.ts` — new
- `electron/remote-control/server.ts` — public relay-hello authenticator
- `electron/paths.ts` — `relayIdentityFile()`
- `electron/app-lifecycle.ts` — construct the connector
- `src/lib/relay-crypto/channel.ts` — `packBatch` / `unpackBatch`
