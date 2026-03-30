---
title: Remove input detection, clear title on new turn
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Remove input detection, clear title on new turn

Two changes to the agent lifecycle:

1. **Remove input detection** — `complete` should persist through user typing, not transition to `idle`
2. **Clear title on new turn** — when `thinking` hook fires, clear the title so the new task (or new thread after `/clear`) gets a fresh title from OSC sequences

## Files to touch

- `electron/terminal-host/agent-detector.ts` — remove `setInputReceived()` method, add `this.title = null` when status transitions to `thinking` in `setStatus()`
- `electron/terminal-host/session.ts` — remove the input detection block from `write()` (lines 302-305)
- `electron/terminal-host/__tests__/agent-detector.test.ts` — remove/update `setInputReceived` tests, add test for title clearing on thinking transition

## Implementation details

### agent-detector.ts

1. Remove the `setInputReceived()` method entirely (lines 225-230)
2. In `setStatus()`, after the `hasBeenActive` tracking block, add title clearing:
   ```typescript
   if (status === "thinking") {
     this.title = null; // Clear title for new turn
   }
   ```

### session.ts

Remove from `write()`:
```typescript
// User input while agent completed → back to idle (agent still present)
if (this.agentDetector.getState().status === "complete") {
  this.agentDetector.setInputReceived();
}
```

The `write()` method should just be:
```typescript
write(data: string): void {
  if (!this._alive || !this.subprocess) return;
  this.writeToSubprocess(encodeFrame(MSG.WRITE, data));
}
```

### Tests

- Remove the test block for `setInputReceived()` (complete→idle with kind preserved)
- Remove the lifecycle test step that calls `setInputReceived()`
- Add a test: when `setStatus("thinking")` is called, title should be cleared to null
- Verify that `complete` status persists (no transition on input)
