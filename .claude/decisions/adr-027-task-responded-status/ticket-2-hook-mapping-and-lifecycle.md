---
title: Update hook mapping and task lifecycle for responded status
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Update hook mapping and task lifecycle for responded status

Change how `Stop` events are handled so the task stays active with a `"responded"` agent status, and only transitions to `"completed"` on `SessionEnd`.

## Hook mapping (`electron/agent-hooks.ts`)
- Change the `Stop` event mapping from `"complete"` to `"responded"`

## Task lifecycle (`electron/main.ts`, lines 854-874)
- **`Stop` event handler (line 854):** Instead of transitioning to `status: "completed"`, keep `status: "active"` and set `lastAgentStatus: "responded"`. Still track `parentComplete` for subagent logic, but don't set `completedAt` or `status: "completed"`.
- **Subagent completion (lines 796-808):** When parent is complete and last subagent finishes, set `lastAgentStatus: "responded"` and keep `status: "active"` (don't transition to `"completed"`).
- **`SessionEnd` event handler (line 875):** This already sets `status: "completed"` — also set `lastAgentStatus: "complete"` explicitly (it currently sets `"idle"` via the hook mapping, but we want `"complete"` for the final state).

## Files to touch
- `electron/agent-hooks.ts` — Change `Stop` → `"responded"` mapping
- `electron/main.ts` — Update `Stop` handler to keep task active, update `SessionEnd` to set `lastAgentStatus: "complete"`, update subagent completion logic
