---
title: Skip task persistence for subagent sessions
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Skip task persistence for subagent sessions

Add a `paneRootSession` map to track the root (parent) session per pane, and use it to gate task persistence in the relay callback.

## Implementation

In `electron/main.ts`, near the existing `sessionStateMap`:

1. Add `const paneRootSessionMap = new Map<string, string>()` — maps paneId to the first sessionId seen.

2. In the relay callback (`agentHookServer.setRelay(...)`), **after** the `client.relayAgentHook()` call and `sessionId` null-check, add root session tracking:
   - If `paneRootSessionMap` has no entry for `paneId`, set `paneRootSessionMap.set(paneId, sessionId)`.
   - If `paneRootSessionMap.get(paneId) !== sessionId`, log a debug message and `return` early (skip all task persistence for this subagent event).

3. On `SessionEnd` for the root session (in the existing terminal/completion status handling), add `paneRootSessionMap.delete(paneId)` to allow the pane to accept a new root session later.

## Files to touch
- `electron/main.ts` — Add paneRootSessionMap, gate task persistence, cleanup on SessionEnd
