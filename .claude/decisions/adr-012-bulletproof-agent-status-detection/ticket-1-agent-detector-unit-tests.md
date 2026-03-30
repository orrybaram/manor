---
title: AgentDetector unit tests — core state machine
status: done
priority: critical
assignee: opus
blocked_by: []
---

# AgentDetector Unit Tests

Comprehensive tests for `electron/terminal-host/agent-detector.ts`. This is the most critical test file — the AgentDetector is the single source of truth for agent status. Test against the CURRENT implementation first (we'll update the implementation in later tickets).

Use vitest with fake timers. No I/O, no real processes.

## Test categories

### 1. Initial state
- Starts in "idle" with null kind, null processName
- getState() returns { kind: null, status: "idle", processName: null, since: <number> }

### 2. Agent detection via updateForegroundProcess()
- Recognizes "claude" → kind: "claude"
- Recognizes "opencode" → kind: "opencode"
- Recognizes "codex" → kind: "codex"
- Stays "idle" when agent first detected (no dot until hook fires)
- Reports null for unknown process ("vim", "git", "python")
- Handles path basenames: "/usr/local/bin/claude" → "claude"
- Case-insensitive: "Claude" matches (verify basename.toLowerCase())
- null/empty name when no previous agent → stays idle

### 3. Hook-driven transitions via setStatus()
- After agent detected: setStatus("running") → status: "running"
- running → waiting: setStatus("waiting")
- waiting → running: setStatus("running") (permission granted)
- setStatus("running") when already running → no callback (dedup)
- setStatus ignored when no agent kind set (defensive guard)

### 4. Agent exit (foreground process disappears)
- Agent running, FG becomes null → "complete"
- Agent waiting, FG becomes null → "complete"
- Agent idle, FG becomes null → stays idle (no complete flash)
- complete → idle after COMPLETE_CLEAR_MS (3000ms, use fake timers)

### 5. Callback behavior
- onStatusChange fires on every ACTUAL transition
- Receives correct AgentState shape
- Does NOT fire when status unchanged
- Fires for complete AND the subsequent idle (two callbacks)
- Fires in correct order during rapid transitions

### 6. Timer behavior (fake timers)
- Complete→idle timer is exactly 3000ms (advance timer, verify)
- Timer cleared when new agent appears during complete
- Timer cleared on dispose()
- Rapid exits don't stack timers (only one pending at a time)

### 7. Edge cases
- Agent switch: claude exits → opencode starts immediately → correct kind/status
- Unknown FG process while agent running (child process like "git") → keeps tracking, status unchanged
- dispose() is safe to call multiple times
- processOutput() is a no-op
- setAltScreen() is a no-op

### 8. Transition sequence capture
- Record ALL status transitions for a complete lifecycle scenario
- Verify exact sequence: idle → running → waiting → running → complete → idle
- Snapshot this sequence for regression detection

## Files to create
- `electron/terminal-host/__tests__/agent-detector.test.ts`
