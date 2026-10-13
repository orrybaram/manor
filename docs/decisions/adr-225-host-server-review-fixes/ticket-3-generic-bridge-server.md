---
title: One generic BridgeServer with table-owned surface config
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# One generic BridgeServer with table-owned surface config

## Problems (verified by review)

- `electron/bridge/server.ts` → `server-core.ts` (706 lines) is a file move: `server.ts:54-66` is a subclass that only assembles a table; `server-core.ts:91-95` `BridgeHost` interface copies the class's public surface. The only dependency to cut was `server.ts` importing `./handlers`.
- Surface identity passed as loose options: `server-core.ts:300-303` picks error text by string-comparing `this.unavailableCode === UNAVAILABLE_CODE`; `admitsOwner` flag + switch (`77,128,342-351`) where the desktop's owner branch is unreachable.
- Two broadcast paths: core subscribes every instance to process-wide `addRendererBroadcastSink` in its constructor (`130`), and adds `broadcast()` (`407-420`). Host `agents.updated`/`agents.status` use the global `publishRendererBroadcast` (`host-server/agents.ts:84,105`) while `projects.changed`/`layout.changed` use `bridge.broadcast`.
- Duplicated table derivation with casts: `host-server/handlers.ts:408-413,486-497` vs `bridge/handlers.ts:88-113` (`Object.fromEntries`, three `ruleSet` calls, `METHODS as Record<string, Method>`). `hostMethod` is an identity wrapper over `method` narrowing `F`.
- Layering: `server-core.ts:19` imports `sessionGrid` from `./handlers/pty`. `BridgeServerDeps` lives in `ipc/types.ts:45-52`.
- Thin wrappers: `publishKeyed`, `broadcast` → private `publish`; `sendTo` used once.
- Auth: `transports/ws.ts:57-72,296,305-312` `BridgeAuthenticator` gained `hello?` only so the owner authenticator can check `role === "owner"` (redundant — the 0600 token is the credential). Result union has two `ok:true` variants discriminated by `"device" in result`, then three ternaries. `host-server/socket.ts:96-103`.

## Do

1. Single generic `BridgeServer<D>` in `electron/bridge/server.ts`; delete `server-core.ts` (or keep the file name `server.ts` only). `new BridgeServer(deps, { table, events, audit })`.
2. `electron/bridge/method.ts`: `export function toHandlerTable<D>(methods, extras): HandlerTable<D>` with the casts confined there. Build `DESKTOP_TABLE` (exported from `bridge/handlers.ts`) and the host table with it. Delete `hostMethod` if it's only narrowing; keep compile-time checking of host handlers against `HostServerDeps` (e.g. via a typed `satisfies`).
3. `HandlerTable` gains `unavailable: { code: UnavailableCode; where: string }` and `localOnlyCallers: ReadonlySet<CallerClass>` (desktop `{local}`, host `{owner}`). `mayCallLocalOnly` = `table.localOnlyCallers.has(callerClass)`. Delete `unavailableCode`, `admitsOwner` options/fields and the string compare. (Leave `heldElsewhere` for now; ticket 4 removes it.)
4. Events: inject the event source. Desktop passes `addRendererBroadcastSink`; the host server creates its own small bus and both `host-server/agents.ts` and owner sync publish to it. One public `publish(ns, event, args, key?: string)`; inline `sendTo`.
5. Move `sessionGrid` and `BridgeServerDeps` into `bridge/server.ts` (handlers/pty imports from there).
6. Authenticator returns `{ ok: true; caller: { callerClass; deviceId: string | null; deviceLabel: string | null } } | { ok: false; … }`; drop `hello` param and role check; spread caller into the connection.
7. `ws.ts` and callers import the class type; update `app-lifecycle.ts` construction, host `server.ts` construction, all tests (`caller-class.test.ts` etc.).
8. Move `dispatchStreamEvent` tests from `electron/app-lifecycle.test.ts` to `electron/agent-stream-events.test.ts`.
9. Type nits: `ptyClaimWinsize(ctx: HandlerCtx<unknown>)` / `assertDevice` use the `PtyViewerDeps` slice types consistently.

## Files to touch
- `electron/bridge/server.ts`, `electron/bridge/server-core.ts` (delete), `method.ts`, `types.ts`, `handlers.ts`, `handlers/pty.ts`, `transports/ws.ts`, `local-only.ts`
- `electron/ipc/types.ts`
- `electron/host-server/handlers.ts`, `server.ts`, `socket.ts`, `agents.ts`
- `electron/app-lifecycle.ts`, `electron/app-lifecycle.test.ts`, `electron/agent-stream-events.test.ts` (new)
- `electron/bridge/__tests__/*`, `electron/host-server/__tests__/*` as needed
