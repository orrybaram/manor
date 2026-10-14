---
title: Provider lifecycle, sleeping hosts, wake and stop
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Provider lifecycle, sleeping hosts, wake and stop

ADR-229 D1. Give `HostProvider` its lifecycle. Make "sleeping" a host
state that nothing wakes by accident. No new provider kind yet: the SSH
provider implements the no-op versions, and tests use a fake provider.

## What to build

- **`electron/backend/providers/types.ts`**
  - Add `ProviderState` (`"up" | "starting" | "sleeping" | "unreachable" | "error"`)
    and `ProviderCapabilities` (`canStop`, `canDestroy`, `autoSleep`).
  - Add `capabilities`, `ensureUp(onProgress?)`, `status()` and the optional
    `setBusy`, `stop` and `destroy`.
  - Widen `kind` to `"ssh" | "recipe"`. Ticket 4 adds the recipe provider.
- **`ssh-provider.ts`**
  - `ensureUp` resolves at once.
  - `status()` returns `up` once the transport has connected and
    `unreachable` after a failed connect. It needs no network call: keep the
    last connect outcome.
  - All capabilities are false.
- **`host-connection.ts` (`RemoteHostConnection`)**
  - `connect()` awaits `provider.ensureUp(line => progress)` before the
    backend connects. Its lines show in `HostStatusInfo.progress`, as
    bootstrap progress does.
  - Before each reconnect attempt, call `provider.status()`. On `sleeping`,
    set status `"sleeping"`, stop the backoff loop, and don't let
    `autoConnect` pollers start a connect.
  - A `wake()` clears that state and connects.
- **`HostStatus`** gains `"sleeping"`. Update every exhaustive switch over it,
  in `electron/` and in `src/` (`src/store/host-store.ts`, `describeHost`,
  `HostIndicator`, `HostOfflineBanner`, `isHostOffline`). Asleep reads as
  away for routing purposes, but its label is "Asleep", not
  "disconnected — reconnecting".
- **`registry.ts`**
  - `wake(hostId)` and `stop(hostId)`. `stop` calls `provider.stop()`
    (refuse if `!capabilities.canStop`), disconnects the backend, and sets
    `sleeping`.
  - `list()` stamps `providerKind` and `capabilities` on each remote host.
- **`electron/bridge/handlers/hosts.ts`**
  - `hosts.wake(hostId)` and `hosts.stop(hostId)`, both with
    `localOnlyCallers: ["owner"]` like `hosts.add`.
  - `hosts.wake` must also be callable by a `full` device on the desktop
    (D7: a phone wakes through home). Check the existing `localOnly` rules
    and pick the narrowest setting that allows it.
- **Wake on intent.**
  - In `electron/server/host-routing.ts`: before refusing a routed **write**
    with `unavailable:host-away`, if the host's status is `sleeping`, call
    `registry.wake(hostId)`, wait for `connected` (bounded by the existing
    connect timeout), then forward.
  - In the renderer router (`src/bridge/router.ts`), for a host whose source
    is sleeping: call `hosts.wake` on home and wait for the host's source to
    connect before sending.
  - Reads never wake.
- **Route manifest.** Add `hosts.wake` and `hosts.stop` to
  `electron/bridge/routes.ts` as `home`.

## Tests

- **`host-connection` with a fake provider:**
  - `ensureUp` runs before the backend connects, and its progress is
    surfaced.
  - A `sleeping` status stops reconnects; `autoConnect` doesn't wake it;
    `wake()` does.
- **`HostRouting`:** a routed write to a sleeping host wakes it, then
  forwards. A routed read doesn't wake it.
- **Router (`src/bridge/__tests__`):** the same rule on the renderer side.

## Files to touch
- `electron/backend/providers/types.ts`, `ssh-provider.ts`
- `electron/backend/host-connection.ts`, `registry.ts`
- `electron/bridge/handlers/hosts.ts`, `electron/bridge/routes.ts`, the
  desktop handler table that lists `hosts.*`
- `electron/server/host-routing.ts`
- `src/bridge/router.ts`, `src/store/host-store.ts`, `src/components/hosts/*`
  (status labels only)
- tests next to each
