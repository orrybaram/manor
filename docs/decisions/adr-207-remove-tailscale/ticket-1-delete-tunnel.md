---
title: Delete the Tailscale tunnel subsystem
status: done
priority: high
assignee: opus
blocked_by: []
---

# Delete the Tailscale tunnel subsystem

ADR-207 D1. Remove all of Tailscale and the tunnel. Pairing roads and tiers stay
untouched for now: `via: "tailscale"` pairing still exists after this ticket, but
it gets a null `pairingUrl` (ticket 3 removes it). The repo must typecheck and
unit tests must pass at the end.

## Steps

- Delete `electron/remote-control/tunnel.ts`, `tunnel-status.ts` and
  `__tests__/tunnel.test.ts`.
  - Move `TunnelState` into `relay/connector.ts` and name it `RelayState`.
  - Replace `STOPPED_TUNNEL_STATUS` uses with the existing
    `STOPPED_RELAY_STATUS`.
- `controller.ts`:
  - Remove the `TunnelManager` imports, `runtime.tunnel`, `which`, `installed`,
    `tailnet`, `tailnetTimer`, `watchTailnet`, `refreshTailnet`,
    `refreshDetection`, `startTunnel`, `stopTunnel` and `killTunnelNow`.
  - Remove the tunnel and tailnet fields from `RemoteControlStatus` and
    `runtimeStatus`, and tunnel stop from `setEnabled(false)` and `shutdown`.
  - Rewrite the header comment.
- `app-lifecycle.ts`:
  - Remove the `TAILSCALE_APP_CLI` which-shim (around :529-539), the
    `TunnelManager` import and construction, and the controller's `which`
    argument.
  - Remove the `process.on("exit")` `killTunnelNow` hook (around :1033-1038)
    and the unused `spawn` import.
- Bridge:
  - `electron/bridge/handlers/remote-control.ts`: delete
    `remoteControlStartTunnel`, `remoteControlStopTunnel` and
    `remoteControlRefreshDetection`, plus their table entries. Fix the
    localOnly-count comment.
  - Update `electron/bridge/local-only.ts` and `src/bridge/unavailable.ts`.
- `electron/routes/system.ts`: delete `POST /remote-control/refresh` and
  `/remote-control/tunnel/start|stop`.
- MCP (`electron/mcp/tools-system.ts`):
  - Delete the `start_tunnel` and `stop_tunnel` definitions and handlers.
  - Remove the "Tunnel:" and "Tailscale on PATH:" lines from
    `formatRemoteStatus`, and the tunnel mentions from tool descriptions.
  - Fix `tools-system.test.ts`.
- Renderer types and store:
  - `src/electron.d.ts`: remove `TunnelStatus` and `TailnetInfo`, and the
    `tunnel`, `installed` and `tailnet` fields. `RelayStatus` gets its own state
    union.
  - `src/store/remote-control-store.ts`: remove `startTunnel`, `stopTunnel`,
    `refreshDetection` and the empty-status fields.
- Settings UI:
  - `src/components/settings/RemoteControlPage.tsx`: delete
    `TAILSCALE_INSTALL_COMMAND`, `ConnectionCard`, `TailnetDevices`, the mount
    `refreshDetection` effect, the tunnel `pageError` dedupe and
    `TunnelConfirmDialog` usage.
  - **Keep a plain loopback-address line** with
    `data-testid="remote-listener-address"` (shown when enabled).
    `tests/e2e/helpers/settings.ts` `enableRemoteControl` reads the port from
    it. Use `src/components/ui/` components.
  - `RemoteControlDialogs.tsx`:
    - Delete `TunnelConfirmDialog`.
    - In `PairingResultDialog`, drop the "No tunnel is running" hint and rename
      `tunnelUrl` → `pairingUrl`.
    - Remove the Tailscale line from the `ResetRelayDialog` copy.
  - Fix the comment in `src/components/ui/ConfirmDialog/ConfirmDialog.tsx:22`.
  - In `SettingsModal.module.css`, delete `.remoteTailnetNote`,
    `.remoteInstallTerminal` and the related comments.
  - `settings-search.ts`: replace the `remote-tunnel` section with a
    `remote-relay` entry (RelayCard already has
    `data-settings-section="remote-relay"`). Drop the "tailscale" keyword.
- Status bar:
  - `remote-exposure.ts`: collapse to the relay road only. No "TUNNEL FAILED"
    and no "stop both".
  - Update `RemoteExposureIndicator.tsx` and `__tests__/remote-exposure.test.ts`
    to match.
- Tests to fix:
  - `controller.test.ts`: remove the tunnel fake and the tunnel/tailnet tests.
    Keep the relay and lifecycle tests.
  - `relay-reset.test.ts`: remove the tunnel stub.
  - `electron/bridge/__tests__/integrations-crossing.test.ts`: remove the
    tunnel mocks and the local-only list entries.
  - Delete the stale status fixture in `ws-bridge.test.ts:207-209`.

## Files to touch
- `electron/remote-control/tunnel.ts`, `tunnel-status.ts`, `__tests__/tunnel.test.ts` — delete
- `electron/remote-control/relay/connector.ts` — own `RelayState`
- `electron/remote-control/controller.ts`, `__tests__/controller.test.ts`, `__tests__/relay-reset.test.ts`, `__tests__/ws-bridge.test.ts`
- `electron/app-lifecycle.ts`
- `electron/bridge/handlers/remote-control.ts`, `electron/bridge/local-only.ts`, `src/bridge/unavailable.ts`, `electron/bridge/__tests__/integrations-crossing.test.ts`
- `electron/routes/system.ts`
- `electron/mcp/tools-system.ts`, `electron/mcp/tools-system.test.ts`
- `src/electron.d.ts`, `src/store/remote-control-store.ts`
- `src/components/settings/RemoteControlPage.tsx`, `RemoteControlDialogs.tsx`, `SettingsModal/settings-search.ts`, `SettingsModal/SettingsModal.module.css`
- `src/components/ui/ConfirmDialog/ConfirmDialog.tsx` (comment)
- `src/components/statusbar/StatusBar/remote-exposure.ts`, `RemoteExposureIndicator.tsx`, `__tests__/remote-exposure.test.ts`
