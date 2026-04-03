---
title: AgentHookServer unit tests — HTTP + event mapping
status: done
priority: critical
assignee: opus
blocked_by: []
---

# AgentHookServer Unit Tests

Tests for `electron/agent-hooks.ts`. Test the HTTP server, event-to-status mapping, IPC delivery, and hook registration logic. Test against the CURRENT implementation first.

## Test categories

### 1. mapEventToStatus (export this for direct testing)
- UserPromptSubmit → "running"
- PostToolUse → "running"
- PostToolUseFailure → "running"
- Stop → "waiting"
- PermissionRequest → "waiting"
- Unknown event → null
- Empty string → null
- Case sensitivity (these should be exact match)

### 2. HTTP server lifecycle
- start() assigns a port > 0
- hookPort getter returns the assigned port
- stop() closes cleanly, port becomes unusable
- Multiple start/stop cycles work without errors

### 3. HTTP request handling
- GET /hook/event?paneId=abc&eventType=UserPromptSubmit → 200
- Missing paneId → 400
- Missing eventType → 400
- Unknown path /foo → 404
- No URL → 404
- Valid request with unknown eventType → 200 (accepted but no IPC sent)

### 4. IPC delivery to renderer
- Valid event sends correct message shape: { kind: "claude", status, processName: "claude", since: <number> }
- Sends to correct channel: `pty-agent-status-${paneId}`
- paneId isolation: event for "pane-1" doesn't send to "pane-2"
- Does not throw when mainWindow is null
- Does not throw when mainWindow.isDestroyed() returns true
- Does not throw when webContents.isDestroyed() returns true

### 5. Hook registration (registerClaudeHooks)
- Creates hooks in settings.json when file doesn't exist
- Creates hooks when file exists but has no hooks key
- Adds missing hooks when some already registered
- Does NOT duplicate hooks already present (idempotent)
- Preserves unrelated settings keys
- Handles invalid JSON gracefully (overwrites)
- All 5 event types are registered (UserPromptSubmit, Stop, PostToolUse, PostToolUseFailure, PermissionRequest)
- Each hook entry points to HOOK_SCRIPT_PATH

### 6. Hook script (ensureHookScript)
- Creates ~/.manor/hooks/ directory if missing
- Writes notify.sh with executable permission (0o755)
- Script contains curl command to MANOR_HOOK_PORT
- Script extracts hook_event_name from JSON stdin

## Mock strategy
- Mock BrowserWindow with { isDestroyed, webContents: { isDestroyed, send } }
- Use temp directories for settings.json and hook script paths
- Use real HTTP requests (localhost) for server tests

## Files to create
- `electron/__tests__/agent-hooks.test.ts`
