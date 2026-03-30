---
title: Add daemon version handshake on connect
status: done
priority: high
assignee: opus
blocked_by: []
---

# Add daemon version handshake on connect

After an app update, the running daemon may be built from the old version. This can cause subtle protocol mismatches. Add a version check during the auth handshake — if versions differ, gracefully restart the daemon.

## Implementation

### 1. Include version in daemon startup

In `electron/terminal-host/index.ts`, read the app version from a constant or environment variable. When the daemon starts, store its version.

Add a `version` field to the auth response. When the daemon receives an `auth` message, respond with `{ ok: true, version: DAEMON_VERSION }`.

### 2. Include version in client auth

In `electron/terminal-host/client.ts`, after sending the `auth` message:
- Read the `version` field from the response
- Compare with the client's version (use `app.getVersion()` from `electron/main.ts`, passed to the client constructor or via a constant)
- If versions differ:
  1. Log a warning: `"Daemon version mismatch: daemon=${daemonVersion}, client=${clientVersion}. Restarting daemon..."`
  2. Disconnect from the daemon
  3. Kill the old daemon process (read PID from `~/.manor/terminal-host.pid`, send SIGTERM)
  4. Wait briefly for cleanup (500ms)
  5. Respawn the daemon and reconnect

### 3. Version source

Use the `version` field from `package.json`. For the daemon, read it at startup. For the client/main process, use `app.getVersion()`.

The daemon can read its version from:
- An environment variable set by the client when spawning: `MANOR_VERSION`
- Or a hardcoded constant built at compile time

The simplest approach: when the client spawns the daemon in `client.ts`, pass the version as an env var `MANOR_VERSION`. The daemon reads `process.env.MANOR_VERSION` and includes it in auth responses.

### 4. Edge cases

- First launch (no daemon running): normal flow, no version check needed
- Daemon was spawned by old version, new version connects: version mismatch triggers restart
- Multiple app windows: only the first connector to detect mismatch should restart; subsequent connections will connect to the new daemon

## Files to touch
- `electron/terminal-host/index.ts` — read version from env, include in auth response
- `electron/terminal-host/client.ts` — send version in auth, check response version, restart on mismatch
- `electron/main.ts` — pass app version to TerminalHostClient constructor or set env var
