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

# ADR-116: Fixed Daemon Socket Path to Preserve Sessions Across Version Upgrades

## Context

The terminal-host daemon socket path currently embeds the full app semver:

```
~/.manor/daemons/{version}/terminal-host.sock
```

When Manor upgrades to a new version, the main process looks for the socket at the new versioned path. Because no daemon is listening there yet, it spawns a fresh daemon. The old daemon — still running under the previous version's path — is abandoned. All PTY sessions (including active Claude Code sessions mid-task) are orphaned in the old daemon and disappear from the UI.

Same-version restarts are unaffected: the path matches, the running daemon is found, and sessions survive. Only cross-version upgrades trigger the session loss ([orrybaram/manor#114](https://github.com/orrybaram/manor/issues/114)).

A secondary problem: abandoned daemons from old versions accumulate in `~/.manor/daemons/` and are never cleaned up.

## Decision

### 1. Fixed socket path

Move all daemon files to a single, version-independent location:

```
~/.manor/daemon/terminal-host.sock
~/.manor/daemon/terminal-host.token
~/.manor/daemon/terminal-host.pid
```

The versioned `~/.manor/daemons/{version}/` directories are no longer created.

### 2. Protocol-version handshake

After authenticating with the daemon, the client sends a `handshake` control request carrying the current app version:

```json
{ "type": "handshake", "clientVersion": "0.5.3" }
```

The daemon replies with its own version:

```json
{ "type": "handshake", "daemonVersion": "0.5.2" }
```

If the versions differ, the client treats the daemon as stale: it sends SIGTERM to the PID from the PID file, waits 500 ms, cleans up the socket and PID files, and respawns a fresh daemon before completing the connection. This ensures the running daemon always matches the binary that spawned it, which matters because the daemon is compiled alongside the Electron binary and may have incompatible internal protocol changes.

For simplicity, any version mismatch triggers a respawn (not just major/minor). Same-version restarts produce a matching handshake and the daemon survives unchanged.

### 3. One-time migration

On the first `doConnect()` call, the client scans `~/.manor/daemons/*/terminal-host.pid` for any leftover daemons from the old path scheme and sends each found PID a SIGTERM. This runs once per process lifetime via a `_migratedOldDaemons` flag and is a no-op once all old daemon directories are gone.

## Consequences

**Better:**
- Sessions survive Manor version upgrades. The new client connects to the existing daemon, detects the mismatch, terminates the old daemon gracefully, and respawns. Users get a brief reconnect (cold restore from scrollback) rather than silent session loss.
- Old versioned daemon directories no longer accumulate in `~/.manor/daemons/`.
- The daemon lifecycle is now explicit: mismatch → kill → respawn, rather than implicit abandonment.

**Neutral:**
- Sessions are still lost on a version-mismatching upgrade (PTY processes cannot migrate across daemon binaries). The improvement is that the loss is *intentional* rather than *silent*.
- The handshake adds one round-trip on every connect, negligible in practice.
- On the first upgrade after this change ships, the old daemon is still at the versioned path. The migration step SIGTERMs it; sessions cold-restore from scrollback that one time.

**Harder:**
- Running two Manor instances simultaneously (e.g., dev build + stable) will cause them to share the same daemon socket and fight over daemon ownership. This was not previously possible to do safely and remains an edge case.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
