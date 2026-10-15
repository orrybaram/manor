---
title: Idle stop counts phones and forwarded viewers
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Idle stop counts phones and forwarded viewers

ADR-230 D1 (gap L1). Today `desktopViewing` counts only `viewer: "desktop"`
connections, so a host can be stopped while a phone is watching it.

## What to build

- **`BridgeServer.viewing(ns, event)`** (`electron/bridge/server.ts`, next to
  `hasDeviceSubscriber` at about :454 and `hasDesktopViewerSubscriber` at
  :469). It returns `{ desktop, device, forwarded }`:
  - `desktop`: a `viewer === "desktop"` connection is subscribed;
  - `device`: a `callerClass === "device"` connection is subscribed;
  - `forwarded`: a `callerClass === "owner"` connection is subscribed.
- **Host status** (`electron/host-server/server.ts:367`). Build
  `viewing: {desktop, device, forwarded}`:
  - each field is true if the matching connection has `pty.output`;
  - `device` is also true if a device has `chat.entry` or `chat.taskEntry`.
    Check the exact event names in `electron/bridge/events.ts`.

  Add `viewing` to `HostServerStatus` (its type is near
  `electron/host-server/relay.ts:159-164`). Keep `desktopViewing` as it is.
- **Desktop** (`electron/backend/host-idle-stop.ts:120`, plus the `Pick<…>`
  at :28 and the wiring at `electron/backend/host-server-sync.ts:166-176`):
  - re-arm when `status.desktopViewing !== false`, or when any `viewing`
    field is true;
  - an older host has no `viewing`, so it is treated as all false.
- Confirm that `HostProxy` subscribes the owner channel to `pty.*` only in
  `watchPty` (`electron/backend/host-proxy.ts:230-258`, `:374`). If it
  subscribes elsewhere, restrict `forwarded` to the subscriptions `watchPty`
  makes.

## Tests (each must fail on the base commit)

- `electron/bridge/__tests__/events.test.ts`, mirroring the
  `hasDeviceSubscriber` test at :76-85 against a real `BridgeServer`. Each
  of the three classes, subscribing and unsubscribing, flips its own field.
- `electron/backend/__tests__/host-idle-stop.test.ts` (fake timers):
  - doesn't stop while `viewing.device` is true;
  - doesn't stop while `viewing.forwarded` is true;
  - stops once both are false;
  - an older status with no `viewing` behaves as today.
- A host-server harness test (`useHostServerHarness`) that subscribes a
  device client to `pty.output` and reads `hostServer.status().viewing.device`.

## Files to touch
- `electron/bridge/server.ts`: `viewing()`.
- `electron/host-server/server.ts`: the status field.
- `electron/host-server/relay.ts` (or wherever `HostServerStatus` lives): the type.
- `electron/backend/host-idle-stop.ts`, `electron/backend/host-server-sync.ts`: the check.
- Tests named above.
