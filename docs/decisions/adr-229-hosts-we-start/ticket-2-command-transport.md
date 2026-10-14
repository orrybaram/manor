---
title: Exec transport and port-pipe
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Exec transport and port-pipe

ADR-229 D3. Reach a host through any command that runs a process on it with
stdio attached (`kubectl exec -i … --`, `docker exec -i <name>`), with no
sshd involved.

## What to build

- **`BridgeSpawner`** (new, `electron/terminal-host/bridge-spawner.ts`).
  Move out of `SshTransport` the code that:
  - spawns a bridge child (`spawnBridgeChild`);
  - reads past or keeps the hello reply (`openBridge`, `awaitHelloLine`,
    `parseServerHello`);
  - tracks children and turns an exit into an error (`exitError`, `track`,
    `waitForExit`).

  It takes a `buildArgv(remoteCommand: string): [cmd, ...args]`.
  - `SshTransport` supplies `ssh -T -F <cfg> <target> <remoteShellCommand(cmd)>`
    and keeps its ControlMaster handling.
  - Behaviour must not change for SSH. The existing `transport-ssh` tests
    stay green with no edits beyond imports.
- **`CommandTransport`** (`electron/terminal-host/transport-command.ts`)
  implements `HostTransport` (`ensureRunning`, `restart`, `connectControl`,
  `connectStream`, `authToken`, `dispose`, `reset`), plus `exec`,
  `openServerBridge` and `openViewerBridge`, exactly as `SshTransport` does.
  - It is built from `argv: string[]`. Each child is
    `[...argv, "sh", "-c", snippet]`, where `snippet` is the same POSIX
    snippet `SshTransport` sends.
  - It takes the same `ensureRemoteHost` hook, so `remoteHostEnsurer`
    bootstraps over exec unchanged. Check that `RemoteExec`'s stdin
    streaming (tarball upload) works through the exec child.
  - It has a generous `handshakeTimeoutMs`. A cold `kubectl exec` can take
    several seconds.
- **`manor-host port-pipe <port> [--host ::1]`** (new mode in
  `electron/terminal-host/index.ts`). It connects to `127.0.0.1:<port>`, or
  `[::1]`, and pipes stdin and stdout to it. It exits when either side
  closes, and exits non-zero with a stderr line when the connect fails.
  - Validate `port` as `assertPort` does.
  - Only loopback addresses are allowed.
- **`CommandHostProvider`** (`electron/backend/providers/command-provider.ts`)
  wraps a `CommandTransport`. It is not yet reachable from a `HostSpec`;
  ticket 4 uses it.
  - `forwardPort` opens a loopback `net.Server` on the preferred or a free
    port. Each accepted socket spawns
    `[...argv, "~/.manor/bin/manor-host", "port-pipe", port]` and pipes the
    two together.
  - `dispose` closes the servers and kills the children.
  - `openServerChannel` and `openViewerChannel` delegate to the transport.
  - The lifecycle methods are no-ops; ticket 4's recipe provider adds the
    real ones around it.

## Tests

- `CommandTransport` against a fake argv that runs a local `sh` (prefix
  `[]`, or `["env"]`). Cover:
  - the daemon bridge hello;
  - the server bridge reading past the hello;
  - the viewer bridge keeping it;
  - `exec` exit codes and stdin.
- `port-pipe` end to end against a local echo server.
- `CommandHostProvider.forwardPort` with a fake spawn: one child per
  connection, and they are cleaned up on dispose.

## Files to touch
- `electron/terminal-host/transport-ssh.ts` (extract), new `bridge-spawner.ts`, new `transport-command.ts`
- `electron/terminal-host/index.ts` (`port-pipe` mode, usage comment)
- new `electron/backend/providers/command-provider.ts`
- tests next to each
