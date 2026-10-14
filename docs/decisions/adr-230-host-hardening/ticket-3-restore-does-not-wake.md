---
title: Launch restore does not wake a sleeping host
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Launch restore does not wake a sleeping host

ADR-230 D3 (gap L3). Mounting the panes restored at launch counts as use and
starts a sleeping box. A restored pane should wait behind the existing asleep
banner until the user shows intent.

## What to build

- **The `wake: false` option.** `pty.create` and `pty.attach` options gain
  an optional `wake?: boolean`, threaded through the preload and bridge
  types. Three places honour `wake === false`:
  - `sleepingTarget` / `wake()` in `src/bridge/router.ts:580-605`: don't call
    `hosts.wake`, and answer `host-unavailable` (reason `sleeping`) as
    `awayError` does.
  - `HostRouting.invoke` in `electron/server/host-routing.ts:280`: skip
    `wakeIfAsleep`, and throw `HostUnavailableError(hostId, "sleeping")` if
    the host is sleeping.
  - `hostGates().pty` in `electron/backend/host-view.ts:65-71`:
    - on `disconnected` or `connecting`, call a new
      `conn.connectNoWake()`, which is `startConnect(false)` in
      `host-connection.ts:329`;
    - then throw `HostUnavailableError(hostId, "sleeping")` if the host
      ended up sleeping;
    - check `startConnect`'s join logic at :445-451, which upgrades to a
      waking connect, and make sure the non-waking path doesn't take it.

  The gate needs to see the option, so pass it through the gated call. Find
  how `hostGates` sees call args.
- **Which panes are restored.**
  - At startup, record the pane ids in the persisted layout that the
    renderer restores. Put the set in the app store (`src/store/`).
  - `useTerminalConnection.create` (`src/hooks/useTerminalConnection.ts:94-112`)
    passes `wake: false` for an id in the set and removes the id after
    that first call, whatever its result.
  - A new pane, a split, a new tab, an agent launch, "wake it" and the
    `useRemoteRecovery` remount all wake as today.
- **Check the banner path.**
  - A `host-unavailable` reply goes to `recordPaneHost` / `awaitHost`
    (useTerminalConnection.ts:39-47), so `HostOfflineBanner` shows "is
    asleep" with "wake it".
  - After a wake, `useRemoteRecovery` (`src/hooks/useRemoteRecovery.ts:58-86`)
    remounts the pane.
  - Pending pane commands (resume) wait until that remount.

## Tests (each must fail on the base commit)

- `src/bridge/__tests__/router.test.ts`, next to the wake tests at :1174-1260.
  With `wake: false` and a sleeping host, there is no `hosts.wake` and the
  answer is `host-unavailable`.
- `electron/server/__tests__/host-routing.test.ts`, next to "wakes the host
  to open a pane on it" (:655): `wake: false` doesn't wake.
- `electron/backend/__tests__/registry.test.ts`, near :1110-1230:
  - the gate with `wake: false` on a disconnected host whose status says
    asleep throws "sleeping", and never runs a waking connect;
  - without the option, the behaviour is unchanged.
- A hook or store test showing that a restored pane id passes `wake: false`
  once, and a fresh pane doesn't.

## Files to touch
- `src/bridge/router.ts`, `electron/server/host-routing.ts`
- `electron/backend/host-view.ts`, `electron/backend/host-connection.ts`
- `src/hooks/useTerminalConnection.ts`, the app store that loads the persisted layout
- The pty option types: `src/electron.d.ts` and the bridge pty handler types
- Tests named above.
