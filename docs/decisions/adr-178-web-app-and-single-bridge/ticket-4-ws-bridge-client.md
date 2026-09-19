---
title: The WebSocket bridge client, installed as window.electronAPI
status: in-progress
priority: critical
assignee: opus
blocked_by: [3]
---

# The WebSocket bridge client, installed as window.electronAPI

ADR-178 D8, renderer side. An object with the `ElectronAPI` shape whose every
method is a frame on the socket from ticket 3. No component in `src/` changes
to get the app rendering; that is the point of installing it under the name
the 66 call sites already use.

## Client

- `src/web/ws-bridge.ts` (new) — `createWsBridge({ token, url }): ElectronAPI`.
  A two-level `Proxy`: `bridge.<ns>` returns a namespace proxy; on it,
  `on<Event>(…)` (a method whose name starts with `on` and whose last argument
  is a function) becomes `subscribe` + a local listener map and returns the
  unsubscribe function the preload returns; anything else becomes an `invoke`
  returning a promise. Match the preload's per-namespace quirks by reading
  `electron/preload.ts` for the namespaces slice 1 serves — in particular
  `pty.onOutput(paneId, cb)` and friends are keyed by `paneId`, which is the
  `key` on the subscribe frame.
- Connection: open on first use, `hello` with the token, wait for `{v:1}`;
  reconnect with capped backoff (1 s → 30 s) and re-send every live
  subscription on reconnect; reject all in-flight invokes with a
  `BridgeDisconnectedError` when the socket drops rather than leaving them
  pending. On close `4401` clear the stored token and reload to the "open the
  link" screen from ticket 2. On `4403` show that this device is not paired
  with full access.
- `BridgeUnavailableError` (with `code: "unavailable:web"`) for a server
  `result` carrying that code, so UI can `catch` it specifically (ticket 6).
- `bridge.platform`: add a `platform: "electron" | "web"` field to `ElectronAPI`
  in `src/electron.d.ts` and to the preload (`"electron"`); the bridge reports
  `"web"`. `electronAPI.isDetached` is `false` on the web.

## Install

- `src/web-main.tsx` — replace ticket 2's stub with `createWsBridge`.
- `src/web/unavailable.ts` — the list of namespaces the web never serves
  (`webview`, `window`, `menu`, `dialog`, `shell`, `clipboard` beyond
  `writeText`, `updater`) so the proxy can reject them **locally** without a
  round trip, with the same error type.

## Tests

- `src/web/__tests__/ws-bridge.test.ts` (vitest, a fake `WebSocket`) — invoke
  round-trip; `on*` subscribe/unsubscribe and delivery keyed by `paneId`;
  reconnect re-subscribes; disconnect rejects in-flight; `unavailable:web`
  surfaces as `BridgeUnavailableError`; locally-unavailable namespaces never
  send a frame.

## Files to touch
- `src/web/ws-bridge.ts` — new, the proxy client
- `src/web/unavailable.ts` — new, local refusals
- `src/web-main.tsx` — install
- `src/electron.d.ts`, `electron/preload.ts` — `platform`
- `src/web/__tests__/ws-bridge.test.ts` — new
