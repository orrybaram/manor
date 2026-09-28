---
title: Route request timeouts through the loss path and add a client heartbeat
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# Route request timeouts through the loss path and add a client heartbeat

See ADR-188 §1 and §2.

## Timeout → loss path

In `electron/terminal-host/client.ts`, `RpcChannel` is constructed with
`() => this.cleanup()`. Change it so a timeout while `connected` calls
`handleDisconnect(reason)`. `handleDisconnect` runs `cleanup()`, logs, and
calls `supervisor.connectionLost()`. While not connected, keep calling
`cleanup()`. `RpcChannel`'s `onTimeout` currently takes no arguments. Either
extend it to receive the request type (`(type: string) => void`, a
`rpc-channel.ts` change; update `__tests__/rpc-channel.test.ts` if it asserts
the call shape) or use a generic reason. Prefer passing the type.

`handleDisconnect(reason?: string)` should include the reason in its existing
`console.warn` line.

## Heartbeat

Add to `TerminalHostClient`:

- `setHeartbeat(opts: { intervalMs: number; timeoutMs: number } | null): void`.
  Stored config. If already connected, (re)start or stop the timer.
- A private timer (`setInterval`, `.unref?.()`), started at the end of a
  successful `doConnect` (right where `this.connected = true` is set) and
  cleared in `cleanup()`.
- Each tick: if not connected, or a ping is already in flight, skip. Otherwise
  `this.rpc.call({ type: "ping" }, timeoutMs)`. On rejection, if still
  connected **and** on the same socket (capture something like
  `rpc.owns(socket)`, or a connection counter bumped per successful connect),
  call `handleDisconnect("heartbeat failed: <message>")`. A timeout will
  already have gone through `onTimeout`, so the guard keeps it from being
  reported twice.
- `checkLiveness(): Promise<boolean>`. If not connected, resolve false. Else
  run (or join) the in-flight ping. Resolve true on pong, false on failure,
  with failure handled exactly as for a tick.

The ping must not call `ensureConnected()`. The existing `ping()` method does,
so do not reuse it; a heartbeat must never trigger a connect.

Keep the existing style: doc comments on every member, same density as the
surrounding code.

## Tests (`electron/terminal-host/client.test.ts`)

Follow the file's existing fake-daemon/transport patterns and fake timers.
Cover:

1. A request timeout while connected starts the reconnect loop. Assert
   `onLost` fires and a reconnect happens. This is the regression test for the
   `cleanup()`-only bug.
2. With a heartbeat set, a daemon that stops answering `ping` makes the client
   report `onLost` within `intervalMs + timeoutMs`, and it reconnects.
3. A healthy daemon: pings go out on the interval, and there is no
   disconnect.
4. `checkLiveness()` returns true against a healthy daemon, false (and
   triggers loss) against a silent one, and false without sending anything
   when disconnected.
5. The heartbeat stops after `disconnect()`, and no pings are sent while
   disconnected.

Run `npx vitest run electron/terminal-host` and `npm run typecheck` (check
`package.json` for the exact script names).

## Files to touch
- `electron/terminal-host/client.ts`: timeout routing, `handleDisconnect(reason)`, heartbeat, `checkLiveness`
- `electron/terminal-host/rpc-channel.ts`: optionally pass the timed-out request type to `onTimeout`
- `electron/terminal-host/client.test.ts`: tests above
- `electron/terminal-host/__tests__/rpc-channel.test.ts`: only if the `onTimeout` signature change needs it
