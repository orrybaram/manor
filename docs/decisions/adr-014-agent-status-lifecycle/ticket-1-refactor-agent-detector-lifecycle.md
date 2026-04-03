---
title: Refactor AgentDetector lifecycle — remove timer, split idle/gone
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Refactor AgentDetector lifecycle — remove timer, split idle/gone

Refactor the AgentDetector state machine to implement the new lifecycle model where `complete` is persistent and `idle` keeps the agent tracked.

## Implementation

### 1. Remove the complete→idle auto-clear timer

In `agent-detector.ts`:
- Delete `COMPLETE_CLEAR_MS` constant
- Delete `completeClearTimer` field
- Delete `scheduleIdleAfterComplete()` method
- Delete `clearTimers()` method
- Remove timer cleanup from `dispose()`

### 2. Update `transitionToComplete()`

It should just transition to complete, no timer:

```typescript
private transitionToComplete(): void {
  this.transition("complete");
}
```

### 3. Rename `transitionToIdle()` → `transitionToGone()`

This method clears everything (kind, processName, title, hasBeenActive) and represents the agent actually leaving. Rename it and update all callers:

- `updateForegroundProcess()` — when shell returns or all PIDs dead
- `sweepStalePids()` — when all tracked PIDs are dead
- `setStatus("idle")` from SessionEnd hook — call `transitionToGone()` instead of `transition("idle")`

### 4. Create new `transitionToIdle()`

A simple transition that keeps kind/processName/title intact:

```typescript
private transitionToIdle(): void {
  if (this.status === "idle") return;
  this.transition("idle");
}
```

### 5. Add `setInputReceived()`

```typescript
/** Called when terminal input is received — transitions complete→idle */
setInputReceived(): void {
  if (this.status === "complete") {
    this.transitionToIdle();
  }
}
```

### 6. Update `setStatus()` for "idle" from SessionEnd

When `setStatus("idle")` is called (from SessionEnd hook), this means the session ended — call `transitionToGone()`:

```typescript
// In setStatus():
if (status === "idle") {
  this.transitionToGone();
  return;
}
```

### 7. Update `updateForegroundProcess()`

All exit paths that currently call `transitionToIdle()` or `transitionToComplete()` when the agent process exits should call `transitionToGone()`:

- When `name` is null and agent was active → `transitionToGone()` (process died)
- When shell returns to foreground while agent was active → `transitionToGone()`
- When `name` is null and agent was complete → `transitionToGone()`
- When `name` is null and agent was idle → `transitionToGone()`

The agent is gone from the pane. Don't go through a "complete" intermediate.

## Files to touch
- `electron/terminal-host/agent-detector.ts` — all changes described above
