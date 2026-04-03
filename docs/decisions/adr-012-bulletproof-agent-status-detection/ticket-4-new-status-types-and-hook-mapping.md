---
title: New status types and expanded hook event mapping
status: done
priority: critical
assignee: opus
blocked_by: [1, 2, 3]
---

# New Status Types & Expanded Hook Mapping

Update the status model from 5 states to 6, subscribe to 11 hook events (up from 5), and fix the wrong Stop→"waiting" mapping. This is the foundation that all subsequent implementation tickets build on.

## Status type changes

```typescript
// OLD
type AgentStatus = "idle" | "running" | "waiting" | "complete" | "error";

// NEW
type AgentStatus = "idle" | "thinking" | "working" | "complete" | "requires_input" | "error";
```

Mapping:
- "running" → split into "thinking" (model generating) and "working" (tool executing)
- "waiting" → split into "complete" (Stop, agent finished) and "requires_input" (PermissionRequest)

## Hook event mapping changes

| Hook Event | Old Status | New Status |
|---|---|---|
| `UserPromptSubmit` | running | thinking |
| `PreToolUse` | (not subscribed) | working |
| `PostToolUse` | running | thinking |
| `PostToolUseFailure` | running | thinking |
| `PermissionRequest` | waiting | requires_input |
| `Notification` (permission_prompt) | (not subscribed) | requires_input |
| `Stop` | waiting (WRONG) | complete |
| `StopFailure` | (not subscribed) | error |
| `SubagentStart` | (not subscribed) | working |
| `SubagentStop` | (not subscribed) | thinking |
| `SessionEnd` | (not subscribed) | idle |

## Files to modify

### `electron/terminal-host/types.ts`
- Update `AgentStatus` type to new 6-state union
- Update `AgentState` interface if needed

### `src/electron.d.ts`
- Mirror the updated `AgentStatus` type

### `electron/agent-hooks.ts`
- Update `mapEventToStatus()` with new mapping table
- Add 6 new hook entries to `MANOR_HOOK_ENTRIES` array
- `Notification` needs matcher: `"permission_prompt"`
- Update `sendToRenderer()` to handle new status values
- PaneStatus type → align with new AgentStatus

### `electron/terminal-host/agent-detector.ts`
- Update `setStatus()` to accept new status values
- Update `transitionToComplete()` — this is now triggered by Stop hook, not just process exit
- Process exit while "thinking" or "working" → complete → idle
- Process exit while "requires_input" → complete → idle
- Process exit while "idle" → stays idle

### `src/store/app-store.ts`
- `setPaneAgentStatus` — update idle check (cleanup logic unchanged)

### `src/components/useSessionAgentStatus.ts`
- Update STATUS_PRIORITY:
  ```
  requires_input: 5  // highest — user action needed
  working: 4
  thinking: 3
  error: 2
  complete: 1
  idle: 0
  ```

### `src/components/AgentDot.tsx`
- Add "thinking" visual: pulsing blue dot (reasoning/generating)
- Change "working" visual: pulsing yellow dot (tool execution — was "running")
- Add "requires_input" visual: solid orange dot (attention needed — was "waiting" green)
- Keep "complete": green checkmark with fadeOut
- Keep "error": red dot

### `src/components/AgentDot.module.css`
- New `.dotThinking` class: blue, pulse animation
- Rename `.dotRunning` → `.dotWorking`: yellow, pulse animation
- Rename `.dotWaiting` → `.dotRequiresInput`: orange, solid (no pulse — steady attention signal)

## Update all existing tests from tickets 1-3
After implementation, re-run tests from tickets 1-3. They test the current behavior but will need the expected values updated to match new status names.
