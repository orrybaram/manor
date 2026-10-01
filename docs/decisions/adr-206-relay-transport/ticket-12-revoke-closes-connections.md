---
title: Revoking a device closes its live connections
status: done
priority: high
assignee: sonnet
blocked_by: [7, 11]
---

# Revoking a device closes its live connections

Found in tickets 7 and 11. A bridge connection is authenticated once, at
`hello`. `RemoteDeviceStore.revoke()` and `resetRelayAddress()` only stop new
hellos, so a revoked device — over the listener `/ws` or the relay — keeps its
live session until it drops. Revoke should mean "now".

## What to build

- `WsBridgeServer` can close every attached connection for a `deviceId` with
  4401 (`closeDevice(deviceId)`), covering `ws` and relay `FrameSocket`s alike.
- `RemoteControlController.revoke(id)` and `resetRelayAddress()` call it for
  each revoked device. (The relay stop in reset already drops relay channels;
  revoke them explicitly anyway, so the order of operations doesn't matter.)
- The 4401 reaches a relay browser through ticket 11's pass-through, so it
  shows the pairing screen.
- Fix the `pnpm lint` error in `src/components/phone/EnableNotifications.tsx`
  (setState in an effect, from ticket 8).

## Tests
- Bridge: a connection for device A and one for device B; `closeDevice(A)`
  closes only A's, with 4401.
- Controller: revoke closes the revoked device's connections; reset closes
  every relay device's connections.
- Connector (fake relay + viewer): revoke while connected → viewer sees 4401.

## Files to touch
- `electron/bridge/transports/ws.ts` (+ test)
- `electron/remote-control/controller.ts`, `electron/app-lifecycle.ts` (+ tests)
- `electron/remote-control/relay/__tests__/connector.test.ts`
- `src/components/phone/EnableNotifications.tsx`
