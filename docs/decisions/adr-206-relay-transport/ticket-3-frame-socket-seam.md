---
title: FrameSocket — the bridge's hello gate off ws
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# FrameSocket — the bridge's hello gate off `ws`

ADR-206 D5. **No behaviour change.** Lift `WsBridgeServer`'s per-socket logic
(hello timeout, hello auth, `previousId` reuse, `BridgeConnection` creation,
frame dispatch, close codes, drop) off `ws`'s `WebSocket` so a relay channel
can be handed to it.

## What to build

In `electron/bridge/transports/ws.ts` (or a new
`electron/bridge/transports/frame-socket.ts` that `ws.ts` uses):

```ts
export interface FrameSocket {
  /** Text frame out. Must not throw; a dead socket drops it. */
  send(text: string): void;
  close(code: number, reason: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  readonly open: boolean;
}
```

- `WsBridgeServer` gains `attach(socket: FrameSocket, authenticate:
  BridgeAuthenticator): void`, which is what `handleUpgrade` now calls after
  wrapping the `ws` socket in an adapter. All of `open`/`onMessage`/`onHello`/
  `send`/`close`/`drop` work on `FrameSocket`.
- `FrameSerialiser` stays in this file and still serialises once per frame.
- Keep `size`, `closeAll`, `dispose` semantics; `closeAll` covers attached
  sockets of every kind.

## Tests

Existing `electron/remote-control/__tests__/ws-bridge.test.ts` (and any bridge
tests) pass unchanged in their assertions. Add a unit test that attaches a
fake in-memory `FrameSocket` and runs: hello timeout → 4401, bad token → 4401,
non-full → 4403, good hello → invoke round trip.

## Files to touch
- `electron/bridge/transports/ws.ts`
- `electron/bridge/transports/frame-socket.ts` — new, if split out
- `electron/bridge/__tests__/` — new test
