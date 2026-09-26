---
title: Daemon role object and typed protocol envelope
status: in-progress
priority: high
assignee: opus
blocked_by: [2]
---

# Daemon role object and typed protocol envelope

Read `index.md`. Scope: `electron/terminal-host/` and the client/daemon protocol.

1. **`DaemonRole`.**
   - Today `index.ts` keeps `namespace` as a mutable module global, plus five `let` path globals that `setNamespace()` reassigns. `namespace === "remote"` branches appear in `setup()`, the `updateEnv` case (`HOOK_ENV_KEYS`), `bootstrap` (calls `enableRemoteMode()`, which throws on a local daemon), `replayHooks` (fakes `"unknown request type"`) and `startServer()`.
   - Replace all of that with a `DaemonRole` interface and two implementations, `localRole` and `remoteRole`, built once in `main()`.
   - A role holds `paths`, `onStartup()`, `acceptsEnvKey(key)`, `hookJournal: HookJournal | null` and `bootstrap()`.
   - Make the server a `startServer(role)` factory instead of relying on module lets.
2. **Bootstrap once.**
   - `remoteRole.onStartup()` runs `bootstrapHost({ mcpServerScriptPath: null })` once and caches the result. That includes `setupZdotdir`/`setupBashrc` and the hook listener.
   - The `bootstrap` request returns the cached `{ agents, warnings }`.
   - Delete the duplicate startup call in `index.ts` and remove `hookPort` from the `bootstrapped` response type.
   - The local daemon's bootstrap path does whatever `app-lifecycle` needs today. Keep that behaviour.
3. **No capability sniffing.**
   - Delete the `resp.message.startsWith("unknown request type")` null-returning paths in `client.ts` (`bootstrap`, `replayHooks`).
   - Delete `remote-backend.ts`'s "does not support bootstrap" branch.
   - Delete the local daemon's fake `replayHooks` error. The registry never calls `replayHooks` for local.
   - The version handshake already replaces older daemons.
4. **One env-key authority.**
   - Only the daemon role decides which env keys it accepts. `remoteRole` rejects all laptop-local keys: `MANOR_HOOK_PORT`, `MANOR_HOOK_PORT_FILE`, `MANOR_WEBVIEW_PORT`, `MANOR_PORTLESS_PORT`.
   - Delete `TerminalHostClientOptions.pushLocalEnv` and the client-side conditional `envKeys` loop.
5. **Per-socket `Connection` object.**
   - Replace the five socket-keyed collections (`authenticatedSockets`, `streamSockets` which nothing reads, `hookStreamSockets`, `execRunners`, `inFlightExecs`) with `Map<net.Socket, Connection>`.
   - `Connection` holds `{ kind, authenticated, execRunner?, inFlightExecs }` and has one `dispose()`.
6. **Typed envelope.**
   - In `types.ts` define `Envelope<T> = T & { requestId: string }` and a `ResponseFor<Req["type"]>` map.
   - The daemon always echoes `requestId`, including on "Invalid JSON" errors when an id can be recovered. Otherwise the client rejects all pending requests rather than guessing.
   - Delete the client's "route id-less reply to the oldest pending request" fallback.
7. **Bridge hello.**
   - Move `BridgeHello` and a `parseHello` into `types.ts`, replacing the two copies in `bridge.ts` and `transport-ssh.ts`.
   - Drop `daemonVersion` (it has no consumer) and the informational `--stream` flag / `stream` parameters.

Run `pnpm build` and the terminal-host tests (`electron/terminal-host/**/*.test.ts`), including `daemon.integration.test.ts`.

## Files to touch
- `electron/terminal-host/index.ts`, `types.ts`, `client.ts`, `bridge.ts`, `transport-ssh.ts`, `transport-local.ts`, `bootstrap-host.ts`, `control-queue.ts`, `ssh-config.ts` (if it builds the bridge command)
- `electron/backend/remote-backend.ts`, `electron/backend/registry.ts` (callers of the removed null paths)
- related tests
