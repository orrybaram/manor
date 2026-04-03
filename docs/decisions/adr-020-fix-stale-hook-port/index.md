---
type: adr
status: proposed
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

# ADR-020: Fix stale MANOR_HOOK_PORT breaking agent status hooks

## Context

Agent status hooks (thinking, working, idle, complete, etc.) stopped working after app restarts. The root cause is that `MANOR_HOOK_PORT` is set as an environment variable inherited by the daemon at spawn time. Since the daemon persists across app restarts and the version (`0.1.0`) never changes, the daemon is never restarted. On subsequent app launches, the hook HTTP server binds to a new random port, but the daemon (and all PTY sessions it spawns) still reference the old port. The hook script curls a dead port and silently fails.

Secondary issue: `electron/terminal-host/agent-detector.ts` has its entire content duplicated (635 lines vs ~318 expected) due to a merge/worktree artifact. The uncommitted working tree has a clean version with a `completeTimer` feature that needs to be committed.

## Decision

### Fix 1: File-based hook port (primary fix)

Write the hook port to `~/.manor/hook-port` on startup. Change the hook script to read from this file instead of `$MANOR_HOOK_PORT`. This ensures all PTY sessions — including those created by a stale daemon — always reach the current hook server.

**Files:**
- `electron/agent-hooks.ts` — write port file in `start()`, read from file in hook script template, clean up in `stop()`
- `electron/main.ts` — no changes needed (still sets env for backward compat but file is authoritative)

### Fix 2: Clean up duplicated agent-detector.ts

Commit the working tree version of `agent-detector.ts` which removes the duplication and adds the `completeTimer` feature (auto-transition from "complete" to "gone" after 5s linger).

**Files:**
- `electron/terminal-host/agent-detector.ts` — commit clean working version
- `electron/terminal-host/__tests__/agent-detector.test.ts` — update "complete is stable" tests for the new linger behavior
- `electron/terminal-host/__tests__/agent-full-pipeline.test.ts` — same

### Fix 3: Commit uncommitted debug logging and relay changes

The working tree has uncommitted changes to `electron/agent-hooks.ts` and `electron/main.ts` with debug logging and the activity-gating relay. These should be included in the commit.

## Consequences

- **Positive**: Hook events work reliably across app restarts without requiring daemon restart
- **Positive**: The file-based approach is simpler and more robust than env var inheritance
- **Positive**: Existing PTY sessions (from before restart) also benefit since they read the file at hook invocation time
- **Risk**: File I/O in the hook script adds ~1ms latency (negligible vs the existing curl call)
- **Tradeoff**: The `$MANOR_HOOK_PORT` env var becomes a fallback; the file is authoritative

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
