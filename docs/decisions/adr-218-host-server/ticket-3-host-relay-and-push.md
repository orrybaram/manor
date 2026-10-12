---
title: Relay identity, pairing and push on the host server
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Relay identity, pairing and push on the host server

ADR-218 D3. Give the host server its own relay room.

- Build `RelayIdentityStore`, `RemoteDeviceStore` and `PushManager` in the host server with `plainFileSecretBox` and `dataDir`.
- Wire `RelayConnector`, `RelayGate` and `WsBridgeServer` the same way `loadRemoteControlRuntime` does in `app-lifecycle.ts:522-568`. Connect on start and reconnect with backoff.
  - Node 20 has no global `WebSocket`: inject `ws` (added to the tarball in ticket 5).
- Pairing:
  - `remoteControl.pair` on the host server mints a `full` relay device and returns the same `…/app/<ver>/#relay=<roomId>.<x25519Pub>&t=<token>` link as `controller.pair()`.
  - `remoteControl.listDevices` and `revoke` are also available.
  - These are LOCAL_ONLY, so only the `owner` caller (ticket 4) reaches them.
- Push: `remoteControl.subscribePush` for devices (ADR-206 D7). Drive pushes from agent status transitions with the same coalescing rules the desktop uses (`NotificationCoalescer`).
- `hostServer.status()` returns the push endpoints this server holds (for ticket 7's dedupe).

## Files to touch
- `electron/host-server/relay.ts` (new), `electron/host-server/index.ts`
- `electron/remote-control/relay/connector.ts`: inject the WebSocket constructor
- `electron/remote-control/controller.ts`: factor the pair-link builder out if it is Electron-bound
