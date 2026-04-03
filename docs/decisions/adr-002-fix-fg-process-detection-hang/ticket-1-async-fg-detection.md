---
title: Convert foreground process detection to async
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Convert foreground process detection to async

Replace synchronous `execFileSync` calls with async `execFile` in the PTY subprocess's foreground process detection, and add a re-entrancy guard to the polling interval.

## Files to touch
- `electron/terminal-host/pty-subprocess.ts` — all changes in this single file:
  1. Replace `import { execFileSync }` with `import { execFile }` and add `import { promisify } from "node:util"`. Create `const execFileAsync = promisify(execFile)`.
  2. Convert `detectAgentFromChildArgs` to `async function` — replace all `execFileSync(cmd, args, opts)` calls with `await execFileAsync(cmd, args, opts)` and access `.stdout` from the result.
  3. Add a module-level `let fgPollRunning = false` guard.
  4. In the `setInterval` callback inside `pollForegroundProcess` (line 206), add early return if `fgPollRunning` is true. Set `fgPollRunning = true` before the detection logic, and `fgPollRunning = false` in a finally block.
  5. Since `detectAgentFromChildArgs` is now async, the interval callback needs to be async — wrap the body in an async IIFE or make the callback async (both are safe with setInterval).
