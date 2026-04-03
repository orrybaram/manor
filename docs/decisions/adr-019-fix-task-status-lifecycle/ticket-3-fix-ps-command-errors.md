---
title: Fix noisy ps command errors in foreground process detection
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Fix noisy ps command errors in foreground process detection

The `detectAgentFromChildArgs()` function in `electron/terminal-host/pty-subprocess.ts` fires `ps -o args= -p PID1 -p PID2 ...` with a 200ms timeout. When the child processes exit between the `pgrep` call and the `ps` call (a common race condition), `ps` fails and the error is logged via `console.error`, flooding stderr with noisy stack traces.

The error: `signal: 'SIGTERM', killed: true` — the 200ms timeout is being exceeded.

## Fix

1. In `detectAgentFromChildArgs()` (line 101-103), change `console.error` to a debug-level log or remove it entirely. This is an expected race condition, not a real error.

2. Before calling `ps`, filter out PIDs that no longer exist by doing a quick `process.kill(pid, 0)` check. This narrows the race window.

3. Consider increasing the timeout from 200ms to 500ms to reduce SIGTERM kills under load — the polling interval is already 500ms so this doesn't add latency.

## Files to touch

- `electron/terminal-host/pty-subprocess.ts` — Fix `detectAgentFromChildArgs()` error handling (lines 49-105)
