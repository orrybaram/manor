---
title: Refactor relay callback with activity gating and subagent tracking
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Refactor relay callback with activity gating and subagent tracking

Rewrite the relay callback closure in `electron/main.ts` (lines 708-757) to fix both bugs.

## Requirements

### Activity gating (Bug 1 fix)
- Maintain a `Map<string, SessionState>` where `SessionState = { subagentCount: number, parentComplete: boolean, hasBeenActive: boolean }`.
- On hook event with a sessionId:
  - If the mapped status is an active status ("thinking", "working", "requires_input"):
    - Mark `hasBeenActive = true` in the session state
    - If no task exists yet for this sessionId, create one now (status "active", set `activatedAt` to current ISO timestamp)
    - If task exists, update `lastAgentStatus` and ensure task status is "active", set `activatedAt` if not already set
  - If the mapped status is "complete", "error", or "idle":
    - If `!hasBeenActive` (session state), **skip** — do not create or update the task. Log a debug message.
    - Otherwise, proceed to subagent-aware completion logic below.

### Subagent tracking (Bug 2 fix)
- On "SubagentStart" (status "working" from `SubagentStart` event — note: need to distinguish SubagentStart from PreToolUse, both map to "working"):
  - To distinguish: pass the raw `eventType` string through the relay alongside the mapped status. Update the relay function signature and `AgentHookServer` to include `eventType`.
  - Increment `subagentCount`
  - Ensure task status is "active"
- On "SubagentStop" (status "thinking" from `SubagentStop` — same disambiguation needed):
  - Decrement `subagentCount` (floor at 0)
  - If `subagentCount === 0 && parentComplete`, transition task to "completed"
  - Otherwise keep task "active"
- On "Stop" (status "complete"):
  - If `subagentCount > 0`: set `parentComplete = true`, update `lastAgentStatus` to "complete", but keep task status "active"
  - If `subagentCount === 0`: transition task to "completed" normally
- On "SessionEnd" (status "idle"):
  - Always transition to "completed" (session is truly over, all subagents are done)
  - Clean up the session state map entry
- On "StopFailure" (status "error"):
  - Transition to "error" regardless of subagent state
  - Clean up the session state map entry

### Relay signature change
Update `AgentHookServer.relayFn` and `setRelay()` to pass `eventType: string` as a 5th parameter. Update the HTTP handler to pass the raw `eventType` through. This is the cleanest way to distinguish SubagentStart/SubagentStop from PreToolUse/PostToolUse since they map to the same AgentStatus values.

## Files to touch

- `electron/main.ts` — Rewrite the relay callback (lines 708-757). Add `SessionState` map. Update relay function signature to accept `eventType`.
- `electron/agent-hooks.ts` — Update `relayFn` type, `setRelay()` signature, and the HTTP handler to pass through `eventType` as 5th arg.
