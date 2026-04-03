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

# ADR-086: Discover and display external agent sessions

## Context

Manor currently only surfaces agent tasks that it spawns itself. Each PTY gets a `MANOR_PANE_ID` environment variable; the hook script (`~/.manor/hooks/notify.sh`) checks for this and exits early if it's absent. This means Claude Code sessions running in other apps (Terminal.app, iTerm, VS Code, Cursor) are invisible even though:

1. Manor's hooks are **already registered globally** in `~/.claude/settings.json` — external sessions fire the hook script, but it bails at `[ -z "$MANOR_PANE_ID" ] && exit 0`.
2. Claude Code writes session metadata to `~/.claude/sessions/{pid}.json` containing `pid`, `sessionId`, `cwd`, `startedAt`, `kind`, and `entrypoint`.
3. IDE connections write lock files to `~/.claude/ide/{pid}.lock` with `ideName` and `workspaceFolders`.

Users running multiple Claude agents across apps have no unified view of what's running.

## Decision

Add external agent session discovery in two layers:

### Layer 1: Hook-based (real-time status for external sessions)

Modify the hook script to handle sessions **without** `MANOR_PANE_ID`. When the env var is absent, the script sends the hook event with a synthetic pane ID derived from the PID (e.g., `external:{pid}`). The hook server routes these to a new `ExternalSessionManager` instead of the existing pane-based relay.

The `ExternalSessionManager` (new class in `electron/external-sessions.ts`):
- Maintains a map of external sessions keyed by PID
- Enriches sessions by reading `~/.claude/sessions/{pid}.json` for `cwd`, `sessionId`, etc.
- Reads `~/.claude/ide/{pid}.lock` if it exists to get the source app name (`ideName`)
- Creates/updates `TaskInfo` entries with `paneId: null` and a new `external: true` flag
- Validates PIDs periodically (every 10s) and marks dead sessions as completed

### Layer 2: Poll-based (catch sessions that started before Manor)

On startup and every 30 seconds, scan `~/.claude/sessions/*.json`:
- Parse each file for PID and session metadata
- Check if PID is alive (`process.kill(pid, 0)`)
- Skip PIDs that match Manor's own daemon or PTY subprocesses
- For unknown live PIDs, create external task entries with status "active" (no granular status until hooks fire)
- For dead PIDs, clean up stale entries

### TaskInfo changes

Add an `external` boolean field to `TaskInfo` (defaults to `false`). External tasks have `paneId: null` and cannot be "opened" in Manor — clicking them is a no-op or shows a detail view with cwd/source app.

### UI

Add an "External" section to the task sidebar that shows external agent sessions. Each entry displays:
- Source app (e.g., "Terminal", "Cursor", "VS Code") or "Unknown"
- Working directory (shortened)
- Agent status dot (if hooks are firing) or a generic "running" indicator
- Time since started

When an external session ends (PID dies), it fades out after a brief linger period, same as internal tasks.

## Consequences

**Benefits:**
- Unified view of all agent activity on the machine
- Zero configuration — works automatically because hooks are already globally registered
- Real-time status for external sessions (when Manor is running)
- Lightweight — no new daemons, sockets, or heavy IPC

**Tradeoffs:**
- External sessions started *before* Manor only get basic alive/dead status until they fire their next hook event
- PID-based identification can have edge cases with PID reuse (mitigated by checking `startedAt` timestamps)
- Adds a new `external` field to TaskInfo (minor schema change, backward compatible)
- Cannot control or interact with external sessions — read-only observation

**Risks:**
- `~/.claude/sessions/` schema is not documented/stable — Claude Code could change it
- PID polling adds minor overhead (mitigated by 30s interval)

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
