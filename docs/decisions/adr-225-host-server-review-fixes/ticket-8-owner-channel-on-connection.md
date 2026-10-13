---
title: Owner channel on RemoteHostConnection and a typed HostServerClient
status: todo
priority: high
assignee: opus
blocked_by: [7]
---

# Owner channel on RemoteHostConnection and a typed HostServerClient

## Problems (verified by review)

- `electron/backend/registry.ts`: `serverClientHostStatus` shadow map (~145), `replaceServerClient` (~225), late-bound `setHostServerSync` (~352), `syncServerClients` run inside every `emitStatus` (~396, ~483), dispose added in `unregister` and `disconnectAll`. Cyclic: `HostServerSync.start()` → `registry.setHostServerSync` → `runHostServerSync` → `onConnected`; `HostServerSyncHook` type exists only for this. `onHostServerStateChange` (~341) already reports `"connected"`.
- `RemoteHostConnection` (`backend/host-connection.ts` ~371) already owns `hookFeed` with this lifecycle.
- `backend/host-server-client.ts`: hand-rolled pending map + subscription set (208-248), dispatch (434-463), restated `settle()` (442-447, from `src/bridge/client.ts:163`). `subscribe` has no non-test caller — listener map, replay in `dial` (369-372) and event branch are dead. Eight wrappers (250-287) are `invoke<T>(ns: string, method: string)` casts.
- `terminal-host/transport-ssh.ts:301` `openServerBridge` copies `openBridge`'s spawn/track/stdio/stderr. `HostServerClient` (328-344) re-implements hello-line hunting without `MAX_PREAMBLE_BYTES`.
- `terminal-host/bridge.ts:76` `await ensureServer()` before the daemon hello on every remote-bridge (control + stream, every connect).

## Do

1. `RemoteHostConnection` constructs `readonly serverClient = new HostServerClient({ hostId, open: provider.openServerChannel?.bind(provider) ?? null })`. `hostConnected()` where connect reaches `"connected"` and on resume; `hostLost()` on disconnect/drop; `dispose()` in `dispose`. `registry.hostServer(id)` = `this.hosts.get(id)?.serverClient`.
2. `HostServerSync` subscribes `onHostServerStateChange((id, s) => s === "connected" && this.sendAll(id))`. Delete `serverClients`, `serverClientHostStatus`, `replaceServerClient`, `syncServerClients`, `setHostServerSync`, `runHostServerSync`, `HostServerSyncHook`, the client's `onConnected` option.
3. `HostServerClient`: delete `subscribe`, listeners, event dispatch. Move `settle` (result frame → value/BridgeUnavailableError/Error) into a shared module (e.g. `electron/bridge/settle.ts` or next to `isUnavailableCode` in `electron/bridge/types.ts`) used by both `src/bridge/client.ts` and the host-server client. Type the client from the host table: `export type HostServerApi = ClientOf<…typeof METHODS…>` (types only, using `electron/bridge/contract.ts` `ClientOf`) and a typed `call(key, ...args)` or small proxy; delete the eight wrappers and update callers (`host-server-sync.ts`, `bridge/handlers/hosts.ts`, app-lifecycle).
4. `transport-ssh.ts`: extract `spawnBridgeChild(command)` and `awaitHelloLine(stream, predicate, maxPreamble)`; use for both bridges. Client receives a stream already past its hello; delete its own hunt.
5. `terminal-host/bridge.ts`: delete the `ensureServer` block and parameter (server-bridge ensures the server; desktop opens it on every connect). Update `server-bridge` injection/tests (`__tests__/bridge.test.ts`) and imports so the daemon bridge no longer imports `host-server/lifecycle`.
6. Update `backend/__tests__/host-server-client.test.ts` and registry tests.

## Files to touch
- `electron/backend/registry.ts`, `host-connection.ts`, `host-server-client.ts`, `host-server-sync.ts`, `providers/types.ts`, `providers/ssh-provider.ts`
- `electron/bridge/types.ts` or new `electron/bridge/settle.ts`, `src/bridge/client.ts`
- `electron/bridge/handlers/hosts.ts`, `electron/app-lifecycle.ts`
- `electron/terminal-host/transport-ssh.ts`, `bridge.ts`, `server-bridge.ts`, tests
- `electron/backend/__tests__/host-server-client.test.ts`
