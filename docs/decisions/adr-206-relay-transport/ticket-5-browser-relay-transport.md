---
title: Browser relay transport, pairing fragment, version redirect
status: done
priority: critical
assignee: opus
blocked_by: [1, 3]
---

# Browser relay transport, pairing fragment, version redirect

ADR-206 D3, D4. The web app, loaded from the relay origin, dials
`/join/<roomId>`, runs the Noise initiator, and then speaks the bridge exactly
as `ws.ts` does.

## What to build

- **Refactor `src/bridge/transports/ws.ts`** so the socket is pluggable: the
  pending map, outbox, subscription replay, hello, reconnect and close-code
  handling stay; the "open a socket, send text, receive text, learn the close
  code" part becomes a small `Pipe` interface. The plain WebSocket is one
  `Pipe`; no behaviour change for the listener-served `/app`.
- **`src/bridge/transports/relay-pipe.ts`** — a `Pipe` over
  `new WebSocket(origin + "/join/" + roomId)` (`binaryType = "arraybuffer"`):
  on open, `createInitiator(x25519Pub, …)` → send message 1 → read message 2 →
  `SecureChannel`; then text frames go through `sealFrame` and incoming relay
  messages through `unpackBatch` + `openFrame`. Relay close codes 4404 (host
  offline) and 4429 (busy/budget) are *reconnectable* and surfaced to the UI
  as "Manor is not reachable right now"; a handshake or decrypt failure is
  treated like 4401 (forget credentials, show pairing screen) only if it is a
  key mismatch, otherwise reconnect.
- **`src/bridge/install-web.ts`** — parse the fragment: legacy form
  `#<token>` (listener) unchanged; relay form
  `#relay=<roomId>.<x25519Pub>&t=<token>`. Store relay credentials under a
  separate key (`manor.web.relay`), strip the fragment, and pick the pipe.
  Choose relay mode when relay credentials exist *and* the page is not being
  served by a Manor listener (the listener origin has no `/join`; decide by
  the presence of the relay credentials, and document the rule).
- **Version redirect:** the host's hello reply gains `appVersion`
  (`electron/bridge/transports/ws.ts`, from `app.getVersion()` passed in). If
  it differs from `__APP_VERSION__` and the page is relay-served, navigate to
  `/app/<appVersion>/`. Guard against loops (one redirect per session via
  `sessionStorage`). If that version 404s, ticket 6's screen covers it.
- **Screens** (`src/web/screens.tsx`): "Manor is not reachable" (host offline,
  retrying), alongside the existing NoToken / Forbidden screens.

## Tests

Unit tests with a fake `WebSocket` and a responder from ticket 1: handshake,
hello, invoke round trip, subscription replay after reconnect, 4404 →
reconnect with backoff, fragment parsing for both forms, version redirect
fires once.

## Files to touch
- `src/bridge/transports/ws.ts`
- `src/bridge/transports/relay-pipe.ts` — new
- `src/bridge/install-web.ts`
- `src/web/screens.tsx`, `src/web-main.tsx`
- `electron/bridge/transports/ws.ts`, `electron/bridge/types.ts` — `appVersion` on hello
