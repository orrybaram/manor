---
title: Ignore Stop events while subagents are active
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Ignore Stop events while subagents are active

In `electron/main.ts`, modify the `Stop` event handler in the relay callback. When `subagentCount > 0`, return early instead of setting `parentComplete = true` and updating the task.

## Files to touch
- `electron/main.ts` — In the relay callback's `Stop` handler (~line 994), change the `if (sessionState.subagentCount > 0)` block to simply return without setting `parentComplete` or updating the task. Remove the `parentComplete` flag entirely since it's no longer needed — the parent's real `Stop` will always arrive when `subagentCount === 0`.
