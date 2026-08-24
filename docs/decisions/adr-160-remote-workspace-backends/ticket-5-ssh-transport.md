---
title: SshTransport — bridge the daemon protocol over ssh
status: todo
priority: critical
assignee: opus
blocked_by: [3, 4]
---

# SshTransport — bridge the daemon protocol over ssh

Implement `HostTransport` (ticket 3) over ssh, using the `remote-bridge` mode
(ticket 4). This is the herdr `SshStdioBridge` design, minus the local unix socket —
Manor can hand the ssh child's stdio straight to the client as a `Duplex`, since we
control both ends in-process.

`SshTransport(target: string, opts: { hookForward?: { localPort: number; remotePort: number } })`:

- `connectControl()` / `connectStream()` spawn
  `ssh -T <managed opts> <target> 'exec "$HOME/.manor/bin/manor-host" remote-bridge'`
  (append `--stream` for the stream connection), then read and strip the single
  `bridgeHello` line from stdout before returning a `Duplex` over the child's
  stdin/stdout. Cache the token from the preamble for `authToken()`.
- **ControlMaster**: write a Manor-owned throwaway ssh config directory (0700) holding
  `ControlMaster auto`, `ControlPath <dir>/ctl`, `ControlPersist 60`, `ServerAliveInterval 30`,
  `ServerAliveCountMax 3`, and pass it with `-F`. Both connections then share one TCP
  session. Remove the directory on `dispose()`.
- **Hook reverse forward**: when `opts.hookForward` is set, add
  `-R <remotePort>:127.0.0.1:<localPort>` to the ssh args. Detect a refused forward in
  stderr (`remote port forwarding failed`) and surface it as a typed, non-fatal warning —
  agents will still run, but their status will not update, and the UI must be able to say so.
- **Timeouts**: handshake read timeout is 60s for this transport (cold TCP + kex + auth
  happens inside it) versus the local 5s. Plumb this through rather than hardcoding in
  the client.
- **Auth errors**: if stderr matches `Permission denied` together with `(publickey`,
  `(keyboard-interactive`, or `(password`, throw an error whose message tells the user to
  verify `ssh <target>` first and to `ssh-add` a passphrase-protected key. Copy herdr's
  `is_remote_auth_error` shape.
- `ensureRunning()` delegates to the bootstrap module (ticket 6) — take it as a
  constructor dependency so this ticket can land with a stub that assumes the host binary
  is present.

Shell-quote the target and any interpolated path (allowlist alnum plus `@%_+=:,./-`,
otherwise single-quote with `'` → `'\''`).

Unit-test the argument construction and the `bridgeHello` parsing with a fake spawn; do
not require a real ssh server here (that lands in ticket 12).

## Files to touch
- `electron/terminal-host/transport-ssh.ts` — new.
- `electron/terminal-host/ssh-config.ts` — new; managed ssh config dir + arg building +
  shell quoting.
- `electron/terminal-host/client.ts` — accept a per-transport handshake timeout.
- `electron/terminal-host/__tests__/transport-ssh.test.ts` — new.
