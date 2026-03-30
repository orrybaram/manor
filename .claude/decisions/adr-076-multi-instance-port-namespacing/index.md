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

# ADR-076: Multi-Instance Port and Daemon Namespacing

## Context

Manor currently uses hardcoded paths in `~/.manor/` for all runtime files:
- `terminal-host.sock`, `terminal-host.token`, `terminal-host.pid` (daemon)
- `hook-port` (agent hook server)
- `webview-server-port` (webview HTTP server)
- `portless-proxy-port` (portless proxy)

When a second Manor instance starts (especially a different version), it:
1. Overwrites port files, breaking the first instance's MCP server and CLI tools
2. Kills the first instance's daemon (version mismatch check in `client.ts` line 88-111)
3. Replaces the daemon socket, disconnecting the first instance's terminal sessions

This makes it impossible to run multiple Manor versions simultaneously (e.g., for testing).

## Decision

**Namespace the terminal host daemon by version** and **use environment variables for per-instance port discovery**.

### 1. Daemon paths: version-namespaced

Move daemon files from `~/.manor/` to `~/.manor/daemons/{version}/`:
- `~/.manor/daemons/{version}/terminal-host.sock`
- `~/.manor/daemons/{version}/terminal-host.token`
- `~/.manor/daemons/{version}/terminal-host.pid`

Each version gets its own daemon. Same-version instances share a daemon (preserving session persistence across restarts). The version mismatch kill-and-restart logic in `client.ts` can be removed since version conflicts can no longer occur.

### 2. Per-instance port discovery: env vars

The hook server, webview server, and portless proxy are per-Electron-process (they already bind to random ports). The problem is shared port files. Add environment variables alongside existing file-based discovery:

- `MANOR_HOOK_PORT` — already exists and works. Make the hook script prefer it over the file.
- `MANOR_WEBVIEW_PORT` — new. Set in `process.env` before daemon spawn (same pattern as `MANOR_HOOK_PORT`). Update MCP server and webview CLI to read env var first, file as fallback.
- `MANOR_PORTLESS_PORT` — new. Set in `process.env` for PTY inheritance.

Port files continue to be written to `~/.manor/` for backward compatibility with external tooling (last-writer-wins is acceptable for single-instance use).

### 3. Hook script: env var priority

Update the hook script to check `$MANOR_HOOK_PORT` first, file second (currently reversed). This ensures PTY sessions always reach their parent Manor instance.

## Consequences

**Better**: Multiple Manor versions can run simultaneously without conflicts. Different versions get isolated daemons with independent session persistence. PTY-spawned tools (hooks, MCP, CLI) always reach the correct instance via env vars.

**Tradeoff**: External tools (webview CLI from a non-Manor terminal) still use file-based discovery and will connect to whichever instance wrote last. This is acceptable — those tools are primarily used from within Manor terminals.

**Risk**: The daemon directory structure change means existing daemons in `~/.manor/` won't be found after upgrade. The client will simply spawn a new daemon (existing sessions are lost on upgrade regardless due to version mismatch).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
