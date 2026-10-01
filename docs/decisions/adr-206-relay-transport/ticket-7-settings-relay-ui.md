---
title: Settings — choosing the relay, pairing, badge, reset
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# Settings — choosing the relay, pairing, badge, reset

ADR-206 D3, D6. Put the relay in front of the user with the same policies the
tunnel has.

## What to build

- **`RemoteControlController`:** take the `RelayConnector` and
  `RelayIdentityStore`. Add `relay: RelayStatus` to `RemoteControlStatus`.
  `startRelay()` (requires enabled, like `startTunnel`), `stopRelay()`,
  `resetRelayAddress()` (stops relay, `identity.reset()`, revokes every device
  paired via relay). `setEnabled(false)` and `shutdown()` stop the relay before
  the server. Never started at launch; state not persisted.
- **Devices:** record `via: "tailscale" | "relay"` on pair (migrate existing
  records to `tailscale`) so reset can revoke the right ones and the list can
  show it.
- **`pair(label, capability, via)`:** for `via: "relay"` the capability must be
  `full` (throw otherwise) and `pairingUrl` is
  `${relayOrigin}/app/${appVersion}/#relay=${roomId}.${x25519Pub}&t=${token}`.
- **Bridge handlers** (`electron/bridge/handlers/remote-control.ts`):
  `startRelay`, `stopRelay`, `resetRelayAddress`, `pair` gains `via`. These
  are `LOCAL_ONLY` (a paired device must not be able to re-pair or reset).
- **UI** (`src/components/settings/` remote control page +
  `RemoteControlDialogs.tsx`): two ways to reach this machine — **Manor relay
  (no install)** and **Tailscale** — each with its start/stop and live state.
  Starting the relay gets the same explicit confirmation as the tunnel, naming
  what becomes reachable and that the relay can't read it. Pairing with the
  relay selected shows only Everything, with one line why. "Reset relay
  address" with a confirm that says every relay device will need re-pairing.
  The REMOTE status-bar badge shows for either; red when the live one failed.
  Use `src/components/ui/` components (Button, Tooltip, Link).

## Tests

Controller unit tests: relay start requires enabled; disable stops relay;
pair via relay rejects non-full and builds the URL; reset revokes only relay
devices. Device record migration.

## Files to touch
- `electron/remote-control/controller.ts`, `devices.ts`
- `electron/bridge/handlers/remote-control.ts`, `electron/bridge/local-only.ts`
- `src/components/settings/*RemoteControl*`, `RemoteControlDialogs.tsx`
- the REMOTE badge component
- `src/electron.d.ts` / bridge contract types as the surface check requires
