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

# ADR-002: Fix foreground process detection blocking main thread

## Context

The PTY subprocess (`electron/terminal-host/pty-subprocess.ts`) polls every 500ms to detect the foreground process name. When the foreground process is a JS runtime (node/deno/bun), `detectAgentFromChildArgs()` calls `execFileSync` for `pgrep` and `ps` — potentially 3+ synchronous calls each with a 200ms timeout. This blocks the Node.js event loop in the PTY subprocess, delaying terminal output processing (`onData` callbacks) and causing sporadic UI hangs.

The worst case: multiple child processes means multiple `pgrep` calls for grandchildren, totaling 600ms+ of blocking time — exceeding the 500ms interval, causing cascading backups.

## Decision

Replace `execFileSync` with async `execFile` (promisified) in `detectAgentFromChildArgs`, and add a re-entrancy guard to `pollForegroundProcess` so a new tick is skipped if the previous async detection is still in flight.

Changes scoped to a single file: `electron/terminal-host/pty-subprocess.ts`.

Specifically:
1. Import `execFile` from `node:child_process` and `promisify` from `node:util`
2. Remove `execFileSync` import
3. Convert `detectAgentFromChildArgs` to an async function using `execFile` (promisified)
4. Add an `fgPollRunning` boolean guard in the interval callback to skip ticks when the previous detection is still running
5. Make the interval callback async-safe (fire-and-forget with error swallowing)

## Consequences

- **Fixes**: Terminal output is no longer blocked during process detection — the event loop stays free to process PTY data
- **Risk**: Minimal — the function already swallows all errors; async version preserves that behavior. The re-entrancy guard means we might skip a detection cycle under load, but that's strictly better than blocking
- **No behavioral change**: The foreground process name is still detected and reported the same way

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
