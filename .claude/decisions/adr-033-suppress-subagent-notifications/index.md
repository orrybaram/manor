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

# ADR-033: Suppress desktop notifications for subagent completions

## Context

When Claude Code spawns subagents via the Agent tool, those subagents fire `Stop` hook events with the same `session_id` as the parent session. The current relay callback in `electron/main.ts` treats any `Stop` event as the parent stopping:

- If `subagentCount > 0`, it sets `parentComplete = true` and keeps the task active
- When `SubagentStop` fires next, it decrements `subagentCount` to 0, sees `parentComplete === true`, and sends a "responded" desktop notification

This means every subagent completion triggers a notification, even though the main agent is still working. For sequential subagents this fires once per subagent; for parallel subagents it fires when the last one completes.

## Decision

When a `Stop` event arrives while `subagentCount > 0`, ignore it entirely — do not set `parentComplete = true` and do not update the task status. The `Stop` event during active subagent work comes from a subagent, not the actual parent. The real parent `Stop` only fires after all subagents have completed and `SubagentStop` events have decremented the count to 0.

**Change**: In `electron/main.ts`, in the `Stop` event handler (~line 994), when `subagentCount > 0`, return early instead of setting `parentComplete = true`.

This preserves the existing behavior for:
- Parent stops with no subagents → immediate "responded" notification ✓
- `SessionEnd` → always completes ✓
- `StopFailure` → always errors ✓

## Consequences

- **Better**: Users only get desktop notifications when the root agent actually finishes, not for intermediate subagent work
- **Better**: No changes to data model, preferences, or UI — purely a logic fix in the relay callback
- **Risk**: If a parent genuinely fires `Stop` while subagents are still running (unlikely in Claude Code but possible in other CLIs), the notification would be deferred until the last `SubagentStop`. This is acceptable behavior — waiting for all work to complete before notifying is the desired UX.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
