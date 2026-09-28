---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-188: Remote host liveness — heartbeat, wake check, main-process log

## Context

A Mac running Manor with two agent panes on a remote (ssh) host went to
sleep. After wake the panes were stale: no output, and typed input never
reached the agents. Only restarting Manor recovered them. The sessions were
intact on the box throughout.

Evidence from the remote box (daemon log, hook journal, sshd log), local time:

- 19:35:47: the ssh connection drops (Mac asleep).
- 19:51:40: the client's reconnect loop reconnects over a new ssh connection
  (sshd: port 50343). Traffic is normal for ~5s, then stops. This was probably
  a dark wake followed by more sleep.
- 19:58:47: real wake. Main's port poller sends `ss`, and the daemon runs it.
  The follow-up `readlink` (sent only after the `ss` reply) never comes, and
  no further 3s poll ticks happen. Requests reach the box, but replies never
  get processed on the Mac.
- 19:59:04: the user quits Manor. sshd reports connection 50343 healthy until
  a clean "disconnected by user" at 19:59:20.

So the transport was up and the client was wedged: box-to-Mac data stopped
being consumed. The exact local cause is unconfirmed: a stalled read side of
the `SshChildDuplex`, or a blocked main process. Main writes no log to disk,
so nothing on the Mac can say which.

Whatever the cause, Manor has no way to notice. Loss detection for a remote
host is entirely "the ssh child exited" (`SshChildDuplex` → socket `close` →
`TerminalHostClient.handleDisconnect` → `ReconnectSupervisor`). That relies on
ssh's `ServerAliveInterval 30 / CountMax 3`, which only catches a dead TCP
peer, not a connection that is alive but not delivering. There is also no
`powerMonitor` handling at all.

A second, related bug turned up during research. `RpcChannel` is built with
`onTimeout: () => this.cleanup()` (`electron/terminal-host/client.ts`). A
request timeout calls `cleanup()`, which sets `connected = false` before the
socket's `close` fires, so `handleDisconnect()` returns at its
`if (!this.connected)` guard. The connection is torn down but:

- the reconnect loop never starts;
- no `onLost`/`hostDisconnected` is emitted, so `HostConnection` keeps saying
  `connected`;
- stream subscriptions are gone until some unrelated pty/exec call happens to
  reconnect lazily. Even then `connectedOutsideLoop()` does not report
  `onReconnected`, so panes are never resnapshotted.

A heartbeat whose failure went through that path would make things worse, not
better.

## Decision

### 1. Unexpected loss always goes through the loss path (`client.ts`)

- `RpcChannel`'s `onTimeout` becomes: while `connected`, `handleDisconnect()`
  (tear down, log, `supervisor.connectionLost()`); otherwise `cleanup()`.
  Before `connected` is set, a timeout happens inside `doConnect()`, whose
  rejection is already handled by `connect()`.
- `handleDisconnect(reason?: string)` takes an optional reason for its log
  line, e.g. "request timed out: resize" or "heartbeat timed out".

### 2. Heartbeat on `TerminalHostClient` (opt-in)

- `setHeartbeat({ intervalMs, timeoutMs } | null)`, set the same way as
  `setReconnectPolicy`. Off by default, so the local daemon is unchanged.
- While connected, every `intervalMs` it sends `{ type: "ping" }` via
  `rpc.call(…, timeoutMs)`. `ping`/`pong` already exist in the protocol, so
  there is no protocol bump and old daemons answer it. Only one ping is in
  flight at a time, and a tick that finds one pending is skipped.
- A ping that fails (timeout, or any rejection while still connected and on
  the same connection generation) calls `handleDisconnect("heartbeat …")`.
  With #1, a timeout already does this through `onTimeout`. The heartbeat
  just must not double-report.
- The timer starts when `doConnect` succeeds and is cleared in `cleanup()`.
  It is `unref()`'d.
- `checkLiveness(): Promise<boolean>` runs one ping now (sharing the in-flight
  one if any) and resolves whether the host answered. Not connected resolves
  false and does nothing.
- The ping goes through the serial mutex like any control request. A ping
  stuck behind a hung serial request is covered, because that request's own
  timeout now goes through #1.

Values for remote hosts: `intervalMs: 15_000`, `timeoutMs: 10_000`. A wedged
connection is noticed within about 25s, and within 10s of a wake (see #3).

### 3. Check on wake (`powerMonitor`)

- `RemoteBackend` enables the heartbeat and exposes `checkLiveness()` on
  `RemoteHostBackend` (`electron/backend/types.ts`).
- `RemoteHostConnection.checkLiveness()`:
  - when `connected`, calls `backend.checkLiveness()`;
  - when `reconnecting`, calls `backend.retryNow()`, so a laptop that just
    woke does not wait out up to 30s of backoff (libuv timers do not advance
    while macOS sleeps, so the pending delay is still pending);
  - otherwise does nothing.
- `BackendRegistry.checkRemoteHosts()` calls it for every remote host.
- `app-lifecycle.ts` subscribes `powerMonitor` `resume` and `unlock-screen` to
  `backendRegistry.checkRemoteHosts()`, after `app.whenReady()`.

### 4. Main-process log on disk (`electron/main-log.ts`)

- `installMainLog()` is called at the top of `electron/main.ts`. It wraps
  `console.log/info/warn/error/debug`: each call still prints as before and is
  also appended, with an ISO timestamp and level, to
  `app.getPath("logs")/main.log` (`~/Library/Logs/Manor/main.log` on macOS).
- Writes use an append `fs.WriteStream`. When `main.log` exceeds 5 MiB at
  install time or during the run, it rotates to `main.log.1`, keeping one old
  file. Failures to open or write are swallowed; logging must never break the
  app.
- Arguments are formatted with `util.format`.

## Consequences

- A wedged remote connection now recovers by itself: the heartbeat trips, the
  supervisor reconnects, and `hostReconnected` resnapshots the panes. It
  recovers whatever the underlying cause is, which is still unknown.
- Fixing the timeout path changes behavior for the local daemon too: a
  timed-out request now starts the local reconnect loop (three quick tries)
  instead of silently disconnecting. That is what ADR-169 intended, but it
  means a flaky local daemon now surfaces as a reconnect.
- A heartbeat only watches the control channel. A stall of just the stream
  channel (output) would not be detected. In the observed incident both
  shared one ssh session, and the control channel stalled. If stream-only
  stalls turn up, a follow-up can add a daemon-side stream heartbeat.
- A false positive (a slow ping over a congested link) costs one reconnect
  plus a resnapshot. That is disruptive but not destructive, since sessions
  live on the box. A 10s timeout is well above LAN or VPN round trips.
- The main log adds a small amount of disk I/O and can hold paths and command
  names. It stays in the user's own Logs directory and is capped at about
  10 MiB.
- The next occurrence will leave `[terminal-host] … heartbeat …` and reconnect
  lines in `main.log`, which should pin down the root cause.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
