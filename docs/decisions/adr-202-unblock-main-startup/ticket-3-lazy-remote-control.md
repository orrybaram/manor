---
title: Load the remote-control runtime and web-push lazily
status: done
priority: high
assignee: opus
blocked_by: []
---

# Load the remote-control runtime and web-push lazily

See ADR-202 §3 for the full design.

- `electron/remote-control/push.ts`: dynamic `import("web-push")` inside
  `PushManager`, memoised, only when a send or VAPID generation is actually
  needed. Keep the constructor's injectable `send`/key-generator seams (make
  their defaults lazy). `import type` for types is fine.
- New light module `electron/remote-control/tunnel-status.ts` holding
  `TunnelKind`, `TunnelState`, `TunnelStatus` and a `STOPPED_TUNNEL_STATUS`
  constant; `tunnel.ts` imports/re-exports them so existing imports keep working.
- `electron/remote-control/controller.ts`: constructor takes
  `loadRuntime: () => Promise<{ server: RemoteControlServer; tunnel: TunnelManager }>`
  and a `which: (bin: string) => Promise<...>` (match `TunnelManager.detect`'s
  logic — move the detection helper into a light module both can use) in place
  of `server`/`tunnel`. Memoise the load; subscribe to `tunnel.onStatus` on
  load. Implement the not-loaded behaviour of every method exactly as the ADR
  lists. Use `import type` for server/tunnel so they are not pulled in.
- `electron/app-lifecycle.ts`: build the controller with a `loadRuntime` that
  does `await import("./remote-control/server")` / `("./remote-control/tunnel")`
  and constructs them with today's arguments (the `ControlDeps` closure, device
  store, `{ push }`, the tunnel's `which`/`spawn`). Remove the static
  `RemoteControlServer`/`TunnelManager` imports. `process.on("exit")` and
  `before-quit` keep calling `killTunnelNow()` / `shutdown()`.
- Check nothing else statically imports `server.ts`/`tunnel.ts` values
  (`ipc/remote-control.ts` and `routes/*` must use `import type`).
- Update/add controller tests (`electron/remote-control/*.test.ts` or
  `electron/__tests__`): status before load; setEnabled(true) loads; disable
  and shutdown before load don't load; refreshDetection doesn't load;
  onAgentStatus before load doesn't throw and still pushes.

Only touch the remote-control block of `app-lifecycle.ts` (lines ~451–497 and
imports); ticket 4 edits the `whenReady` handler.

## Files to touch
- `electron/remote-control/push.ts`
- `electron/remote-control/tunnel-status.ts` — new
- `electron/remote-control/tunnel.ts`
- `electron/remote-control/controller.ts`
- `electron/app-lifecycle.ts` — remote-control construction + imports
- relevant tests
