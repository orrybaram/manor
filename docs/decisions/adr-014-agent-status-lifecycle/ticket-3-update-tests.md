---
title: Update tests for new lifecycle model
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Update tests for new lifecycle model

Update all agent-related tests to reflect the new lifecycle: complete is persistent, idle keeps the agent, gone removes it.

## Implementation

### 1. Update `agent-detector.test.ts`

- **Remove timer tests**: Delete any tests that assert complete→idle after 3s timer, or that reference `COMPLETE_CLEAR_MS` / `scheduleIdleAfterComplete`.
- **Add `setInputReceived` tests**: Test that calling `setInputReceived()` when status is `complete` transitions to `idle` (keeping kind). Test that calling it in other states is a no-op.
- **Update idle/gone tests**: Tests that previously expected `transitionToIdle()` to clear kind should now expect `transitionToGone()` behavior. Tests where idle is expected to keep kind should use the new `transitionToIdle()`.
- **Update process exit tests**: When shell returns to foreground, expect `transitionToGone()` (kind=null, status=idle) instead of going through complete first.

### 2. Update `agent-full-pipeline.test.ts`

- **Remove timer-related assertions**: Any test that uses `vi.advanceTimersByTime(3000)` to wait for complete→idle should be updated.
- **Add lifecycle scenario test**: Full flow: detect agent → thinking → working → complete → input received → idle (kind still set) → thinking → complete → process exit → gone (kind null).
- **Update existing pipeline tests** that check for complete→idle transitions.

### 3. Update `agent-status-store.test.ts`

- **Update idle removal test**: `idle` with `kind: "claude"` should stay in store. `idle` with `kind: null` should be removed.
- **Add test**: setting status to `idle` with kind keeps the entry; setting status to `idle` with `kind: null` removes it.

### 4. Run all tests

Run: `bun test electron/terminal-host/__tests__/ electron/__tests__/agent-hooks.test.ts src/store/__tests__/agent-status`

Ensure all tests pass.

## Files to touch
- `electron/terminal-host/__tests__/agent-detector.test.ts` — update for new lifecycle
- `electron/terminal-host/__tests__/agent-full-pipeline.test.ts` — update pipeline tests
- `src/store/__tests__/agent-status-store.test.ts` — update store idle behavior
