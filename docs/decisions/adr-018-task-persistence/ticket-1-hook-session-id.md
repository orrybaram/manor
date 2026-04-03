---
title: Capture session_id in hook script and relay
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Capture session_id in hook script and relay

Enhance the hook infrastructure to extract and forward the Claude `session_id` from hook event JSON.

## Files to touch

- `electron/agent-hooks.ts` — Three changes:
  1. Update `HOOK_SCRIPT` constant to also extract `session_id` from stdin JSON using the same grep pattern used for `hook_event_name`, and pass it as `--data-urlencode "sessionId=$SESSION_ID"` in the curl call
  2. Update the HTTP handler in `AgentHookServer` to parse `sessionId` from `url.searchParams`
  3. Extend `relayFn` type and `setRelay()` signature to `(paneId: string, status: AgentStatus, kind: AgentKind, sessionId: string | null) => void`

## Implementation notes

- The hook JSON contains `"session_id": "abc123"` — extract with the same grep pattern used for `hook_event_name`
- If `SESSION_ID` is empty, still send the curl (just without that param) for backward compat
- The `ensureHookScript()` already overwrites the script on startup, so the update will auto-deploy
- Update the relay call in `electron/main.ts` line ~680 to accept the new `sessionId` param (just pass it through for now, wiring comes in ticket 3)
