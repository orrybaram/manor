---
title: Update tests for unified hook routing
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Update tests for unified hook routing

Update existing tests and add new ones to verify that hook events flow through the AgentDetector state machine correctly.

## Implementation

### 1. Update agent-hooks tests (`electron/__tests__/agent-hooks.test.ts` or create if missing)

Test that `mapEventToStatus` still returns correct mappings (this is unchanged but should be verified).

Test that `AgentHookServer`:
- Calls the relay function (not direct IPC) when receiving hook events
- Passes correct paneId and mapped status to the relay function
- Ignores unknown event types (relay not called)

### 2. Add integration test for hook → daemon → detector flow

Create or update `electron/terminal-host/__tests__/agent-full-pipeline.test.ts` to add a test case:

- Create a Session
- Call `session.setAgentHookStatus("thinking")` — verify detector transitions to thinking
- Call `session.setAgentHookStatus("working")` — verify detector transitions to working
- Call `session.setAgentHookStatus("complete")` — verify detector transitions to complete
- Wait 3 seconds — verify detector auto-transitions to idle
- Verify `hasBeenActive` is set correctly (complete is not ignored)
- Verify fallback debounce works: after `setAgentHookStatus("thinking")`, a fallback `setFallbackStatus("complete")` within 2 seconds is ignored

### 3. Verify existing tests still pass

Run the full test suite to ensure no regressions:
- `agent-detector.test.ts` — unchanged behavior
- `agent-full-pipeline.test.ts` — existing tests unchanged
- `title-detector.test.ts` — unchanged
- `agent-status-store.test.ts` — unchanged
- `agent-status-multi-pane.test.ts` — unchanged

## Files to touch
- `electron/__tests__/agent-hooks.test.ts` — update or create tests for relay-based hook server
- `electron/terminal-host/__tests__/agent-full-pipeline.test.ts` — add hook→daemon integration test
