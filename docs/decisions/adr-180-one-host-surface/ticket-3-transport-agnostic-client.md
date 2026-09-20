---
title: The renderer client becomes transport-agnostic
status: done
priority: critical
assignee: opus
blocked_by: [2]
---

# The renderer client becomes transport-agnostic

ADR-180 D3. Split `src/web/ws-bridge.ts` into the client and its transports,
and install the client on the desktop. At the end of this ticket
`window.electronAPI` on the desktop is a proxy over `manorHost`, falling
through to the native namespaces — and since no handler has moved yet, every
namespace falls through and the app behaves exactly as before.

## `src/bridge/`

- **`client.ts`** — everything in `BridgeConnection` that is not a WebSocket:
  the `Proxy`, `looksLikeSubscription`, `eventNameFor`, `SUBSCRIPTION_EVENTS`,
  `ROOT_SUBSCRIPTIONS`, `ROOT_VALUES`, `NOT_MEMBERS`, the pending map, the
  outbox, the subscription registry, `BridgeUnavailableError`,
  `BridgeDisconnectedError`. Takes a transport:

  ```ts
  export interface BridgeTransport {
    /** Resolves when the host is reachable; may be called more than once. */
    start(): void;
    invoke(ns: string, method: string, args: unknown[]): Promise<unknown>;
    subscribe(ns: string, event: string, key: string | undefined,
              cb: (...args: unknown[]) => void): () => void;
    /** Host-assigned connection id, once known. */
    readonly rendererId: string | null;
    readonly platform: "electron" | "web";
    /** Values the transport answers without a round trip. */
    readonly rootValues: Record<string, unknown>;
    /** Namespaces the transport serves itself (native preload, or the tab). */
    readonly localNamespaces: Record<string, unknown>;
    /** `ns.method` entries the transport answers itself. */
    readonly locallyServed: Record<string, (...args: unknown[]) => unknown>;
  }
  ```

  Resolution order for `ns.method`, and write it down in the header:
  `localNamespaces[ns]` → `locallyServed["ns.method"]` →
  `UNAVAILABLE_NAMESPACES` → the transport.

- **`transports/ws.ts`** — the socket, hello, reconnect with capped backoff,
  the 4401/4403 handling, `bridgeUrlFromLocation`, `WEB_TOKEN_KEY`,
  `forgetWebToken`, the JSON framing, the outbox flush on ready. Its
  `localNamespaces` is empty, `locallyServed` is `LOCALLY_SERVED` from
  `src/web/unavailable.ts`, `rootValues` is today's `ROOT_VALUES`.

- **`transports/ipc.ts`** — over `window.manorHost`. `start()` is a no-op
  (IPC is up before the page runs), `rendererId` is `manorHost.rendererId`,
  `platform` is `"electron"`, `rootValues` comes off `manorHost`
  (`isDetached`, `detachedWindowId`, `claim`, `env`), `localNamespaces` is
  `manorHost.native` — the preload namespaces that stay — and `locallyServed`
  is empty. Unwraps the `__bridgeError` envelope from ticket 2 into
  `BridgeUnavailableError` or a plain `Error`.

- **`unavailable.ts`** — `src/web/unavailable.ts` moves here unchanged; the
  set is about what a *browser* cannot do, so the WS transport is its only
  consumer.

`src/web/ws-bridge.ts` and `src/web/unavailable.ts` are deleted;
`src/web-main.tsx` and `src/web/screens.tsx` import from `src/bridge/`.

## `src/main.tsx`

Install the bridge before rendering, mirroring `web-main.tsx`:

```ts
const api = createBridge(createIpcTransport(window.manorHost!));
(window as unknown as { electronAPI: ElectronAPI }).electronAPI = api;
await loadTerminalFonts();
```

`main.tsx` must assume the preload ran; if `window.manorHost` is missing,
render a plain fatal message rather than a blank screen.

## Notes

- Keep `src/web/__tests__/ws-bridge.test.ts`'s assertions; move it to
  `src/bridge/__tests__/client.test.ts` and drive it through a fake transport.
  Add a second file for the WS transport's socket behaviour.
- The proxy must keep answering `platform` synchronously — 40-odd components
  branch on it during render.
- Do **not** remove any preload namespace in this ticket. `manorHost.native`
  is, for now, every namespace `electronAPI` has; tickets 5–10 take them out
  of it one group at a time, and each one that leaves starts going over the
  wire on the very next call.

## Files to touch
- `src/bridge/client.ts` — new; the proxy and the bookkeeping, lifted from `src/web/ws-bridge.ts`
- `src/bridge/transports/ws.ts` — new; the socket half
- `src/bridge/transports/ipc.ts` — new; over `window.manorHost`
- `src/bridge/unavailable.ts` — moved from `src/web/unavailable.ts`
- `src/web/ws-bridge.ts`, `src/web/unavailable.ts` — deleted
- `src/main.tsx` — install the bridge before render
- `src/web-main.tsx`, `src/web/screens.tsx` — import paths
- `electron/preload.ts` — expose `native: { … }` on `manorHost`
- `src/bridge/__tests__/client.test.ts` — moved from `src/web/__tests__/ws-bridge.test.ts`

## Folded in from ticket 1

`src/web/ws-bridge.ts` hand-mirrors the protocol: `UNAVAILABLE_CODE`, the two
close codes, the frame shapes. Ticket 1 repointed its comments at
`electron/bridge/types.ts` and left the duplication, because this is the
ticket that resolves it. Import the constants and the frame types from
`electron/bridge/types.ts` rather than restating them — a type-only import
across that boundary is already precedent (`electron/mcp/tools-panes.ts`
imports `LayoutSnapshot` from `src/store/`), and `types.ts` was deliberately
written to import nothing so it can be imported from anywhere.

## Folded in from ticket 2

- **Structured clone is stricter than JSON in one direction and looser in
  another.** Nothing has crossed the IPC transport in a running app yet; this
  ticket is the first proof. A handler whose result is a function, a class
  instance or anything else structured clone refuses will throw at the
  `webContents.send` / `ipcMain.handle` boundary, where the WS transport would
  have quietly dropped it in `JSON.stringify`. If you hit one, fix the handler
  to return plain data rather than teaching a transport to cope.
- **An unrecognised sender's invoke never settles**, on purpose (a hostile
  guest must not learn anything). The cost is that a *legitimate* window that
  somehow speaks before `trackRendererWindow` runs hangs instead of erroring,
  with one `console.warn` as the only clue. Both the primary and the detached
  paths register synchronously before any load today. `main.tsx` installing
  the bridge is the first code that could change that — make sure it cannot.
