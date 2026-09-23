---
title: One transport core — subscription registry, result frames, receive()
status: done
priority: medium
assignee: opus
blocked_by: [4]
---

# One transport core — subscription registry, result frames, receive()

ADR-182 D5.

## SubscriptionRegistry
- Add a single `SubscriptionRegistry` in `src/bridge/subscription-registry.ts` with:
  - reference counting
  - fan-out by key
  - `keys()` for replaying subscriptions after a reconnect
- **Semantics.** Keep the preload's reference-counted array semantics (see the comment at `preload.ts:367-372`: a `Set` merges duplicate callbacks and breaks StrictMode).
- **Preload.** The preload shrinks to `send(frame)` plus one `onEvent(cb)`, feeding the registry.
- **WS client.** `src/bridge/transports/ws.ts` uses the registry, which fixes its `Set` bug. It replays from `keys()` on reconnect.
- **Constants.** Move the shared constants into `electron/bridge/types.ts` and import them everywhere: `"*"`, the IPC channel names, the WS close codes.
- **Event names.** `client.ts` imports the `SUBSCRIPTIONS` table instead of rebuilding it. Delete `eventNameFor`, `looksLikeSubscription` and `SUBSCRIPTION_EVENTS`.
- **Root members.** Move the three root-level members into namespaces: `projects.onChanged`, `appCommands.onCommand`, `appCommands.result`. That deletes `ROOT_SUBSCRIPTIONS`, `ROOT_INVOKES`, `WireAliases`, `AsSurface`, and the `ns === null` branches in `client.ts`.

## One result frame
- The IPC server transport (`electron/bridge/transports/ipc.ts`) returns the `ResultFrame` itself, the same as WS.
- The client uses one `settle(frame)` for both transports.
- Delete `BridgeErrorEnvelope`, `bridgeError` and `asEnvelope`, including the d.ts declaration.

## BridgeServer.receive
- Add `BridgeServer.receive(conn, raw)`, which owns frame decoding and invoke/subscribe/unsubscribe routing, including the `bad-frame` answer.
- Both server transports call it instead of re-implementing it.

## Dead code
Delete:
- `BridgeRefusal` and its check (`server.ts:240`)
- `WsBridgeServer.handleStreamEvent`
- the `locallyServed` loop in `src/bridge/transports/ipc.ts:66-72`
- the test-only `server?`/`ownsServer` options, if tests can construct directly
- the unused `AttachmentResult` returns in `electron/pty-attachments.ts`
- the release-without-viewer branch in `pty-attachments.ts`, if it is test-only

## Window close
- Use `BridgeServer.onDisconnect` for `layoutStore.releaseWindow`.
- Delete the duplicate release in `electron/app-lifecycle.ts:170-185`.

## Detached windows
- Identify a detached window by `claim` only.
- `useLayoutMode.ts` checks `window.electronAPI.claim !== null`.
- Delete `isDetached` and `detachedWindowId` from the d.ts, the preload and both client transports.

## Files to touch
- `src/bridge/**`, `electron/bridge/server.ts`, `electron/bridge/transports/*.ts`, `electron/bridge/types.ts`, `electron/preload.ts`, `src/electron.d.ts`
- `electron/pty-attachments.ts`, `electron/app-lifecycle.ts`, `src/hooks/useLayoutMode.ts`, and the related tests
