---
title: The bridge becomes a server with transports
status: done
priority: critical
assignee: opus
blocked_by: []
---

# The bridge becomes a server with transports

ADR-180 D1. Promote the handler table and its dispatcher out of
`remote-control/` and split the WebSocket out of them, so a second transport
can exist. **No behaviour change**: the web app must work identically at the
end of this ticket, and `electron/remote-control/__tests__/ws-bridge.test.ts`
must still pass (updating its imports is fine; changing its assertions is not).

## What to build

Create `electron/bridge/`:

- **`types.ts`** — the wire frames (`InvokeFrame`, `ResultFrame`,
  `SubscribeFrame`, `UnsubscribeFrame`, `EventFrame`), `BRIDGE_PROTOCOL_VERSION`,
  `UNAVAILABLE_CODE`, `BridgeRefusal`, and:

  ```ts
  /** What dispatch knows about a caller. A socket and a window are both this. */
  export interface BridgeConnection {
    readonly id: string;
    /** `local` = an Electron renderer window; `device` = a paired `full` device. */
    readonly callerClass: "local" | "device";
    /** Audit identity, or null for a local caller (ADR-180 D4). */
    readonly deviceId: string | null;
    send(frame: EventFrame | ResultFrame): void;
  }
  ```

- **`server.ts`** — `BridgeServer`: the connection registry, the
  `ns.method` dispatch (argument padding + `ORIGIN_ARGS`, `MUTATING` auditing,
  `BridgeRefusal` → `unavailable:web`, unknown method → `unavailable:web`), the
  per-connection subscription map with its `key`/`ALL_KEYS` filtering, the
  `renderer-broadcast` sink, the `pty` stream fan-out and the
  `onAttachmentChange` winsize-owner push. All of this is lifted verbatim out
  of `WsBridgeServer`; it is the same code with `this.connections` holding
  `BridgeConnection`s instead of `{socket, …}`. Public surface:

  ```ts
  accept(conn: BridgeConnection): void;
  drop(connectionId: string): void;
  dispatch(conn: BridgeConnection, frame: InvokeFrame): Promise<ResultFrame>;
  subscribe(conn, ns, event, key?): void;   unsubscribe(conn, ns, event, key?): void;
  sendTo(connectionId: string, frame: EventFrame): void;   // ticket 4 uses it
  onDisconnect(cb: (connectionId: string) => void): () => void;
  ```

- **`handlers.ts`** — today's `ws-handlers.ts` moved, with `WS_HANDLERS`
  renamed `HANDLERS`, plus an exported `LOCAL_ONLY: ReadonlySet<string>`
  (empty in this ticket; ticket 7/10 fill it) which `dispatch` consults: a
  `device` caller hitting a `LOCAL_ONLY` method gets `unavailable:web`.
  Handler bodies do not move yet — later tickets move them into
  `electron/bridge/handlers/*.ts` as they grow.

- **`transports/ws.ts`** — what is left of `ws-bridge-server.ts`: the
  `WebSocketServer`, `BRIDGE_PATH`, the hello frame and its timeout, the close
  codes, the `BridgeAuthenticator` call, reconnect-id reuse, JSON
  encode/decode and `MAX_FRAME_BYTES`. On a successful hello it builds a
  `BridgeConnection` with `callerClass: "device"` and calls
  `server.accept(...)`; on close, `server.drop(...)`.

`electron/remote-control/ws-bridge-server.ts` and `ws-handlers.ts` are deleted;
`controller.ts` / `server.ts` / `app-lifecycle.ts` import from the new paths.
Keep `BRIDGE_PATH`, `CLOSE_UNAUTHORIZED`, `CLOSE_FORBIDDEN` exported from
`transports/ws.ts` so `remote-control/server.ts` and the tests keep working.

## Notes

- The `deps: IpcDeps` object and every handler signature stay exactly as they
  are. Nothing about `IpcDeps` changes in this ADR.
- `pty-attachments`' `{kind:"bridge", id}` origin stays as-is here; ticket 5
  unifies it.
- Do not widen the table. It still has 35 entries at the end of this ticket.

## Files to touch
- `electron/bridge/types.ts` — new; frames, `BridgeConnection`, refusal type
- `electron/bridge/server.ts` — new; dispatch + connections + subscriptions, lifted from `WsBridgeServer`
- `electron/bridge/handlers.ts` — moved from `electron/remote-control/ws-handlers.ts`; add `LOCAL_ONLY`
- `electron/bridge/transports/ws.ts` — what remains of `electron/remote-control/ws-bridge-server.ts`
- `electron/remote-control/{ws-bridge-server,ws-handlers}.ts` — deleted
- `electron/remote-control/{server,controller}.ts` — import paths, unchanged auth
- `electron/app-lifecycle.ts` — construct `BridgeServer` and hand it to the WS transport
- `electron/remote-control/__tests__/ws-bridge.test.ts` — import paths only
- `electron/remote-control/__tests__/allowlist.test.ts` — import paths only
