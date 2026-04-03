---
title: Map SessionStart hook event to agent status
status: in-progress
priority: high
assignee: haiku
blocked_by: []
---

# Map SessionStart hook event to agent status

Add `SessionStart` to the event-to-status mapping in the hook server so Codex's session start event is recognized.

## Implementation

In `mapEventToStatus()`, add a case for `"SessionStart"` that returns `"thinking"`. This signals the agent has started and is processing. This is important for Codex because it doesn't have a `SessionEnd` event — `SessionStart` is the first lifecycle signal we get.

## Files to touch
- `electron/agent-hooks.ts` — Add `"SessionStart"` case to the `mapEventToStatus()` switch statement, returning `"thinking"`.
