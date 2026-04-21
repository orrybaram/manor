---
title: Unit tests for stale-active sweep and gone-bridge
status: done
priority: medium
assignee: haiku
blocked_by: [1, 2]
---

# Unit tests for stale-active sweep and gone-bridge

Extend `electron/__tests__/relay-subagent-tracking.test.ts` with coverage for the two new safety nets from tickets 1 and 2. Follow the existing patterns in that file.

## Implementation

Add these cases. Each should be a new `it(...)` inside the relevant `describe(...)` block.

### In the `"createHookRelay — stale-Stop safety-net sweep"` describe block

Switch the existing `describe` title to cover both sweeps, e.g. `"createHookRelay — sweep safety nets"`. Use the `sweepStaleSessions` method from `HookRelayContext` directly instead of the local `runSweep` helper — delete `runSweep` once both cases use the real method.

Import `STALE_ACTIVE_MS` from `../hook-relay`.

1. **`case 7: stale-active sweep fires after STALE_ACTIVE_MS when Stop never arrived`**
   - Fire: `UserPromptSubmit` → `working` status. No Stop event.
   - Advance time by `STALE_ACTIVE_MS + 1000` (61s).
   - Call `sweepStaleSessions()`.
   - Expect the task's `lastAgentStatus` to be `"responded"`.

2. **`case 8: stale-active sweep does NOT fire if hasBeenActive is false`**
   - Create a session state manually (or fire no active events on the session) such that `hasBeenActive` is false.
     - Simplest: just don't fire any events on a session. But then `sessionStateMap` has no entry. So instead, verify that the sweep doesn't synthesize one.
     - Alternative: fire a `Stop` that is dropped (the `hasBeenActive` check at line 232 of `hook-relay.ts` also applies to terminal events, but it's stored in state via the active-status path). To force `hasBeenActive=false` with a state entry: fire a non-active status event. The simplest is to construct the scenario by firing `UserPromptSubmit` with `thinking` (which IS active) and verifying the inverse — so instead, just skip this case and rename to case 8 below.
   - Pragmatic approach: assert that a session with no prior activity and no entry in `sessionStateMap` is not affected by the sweep (no task updates).

3. **`case 9: stale-active sweep does NOT fire if task is already terminal`**
   - Fire: `UserPromptSubmit` → `working` → `Stop` (which applies responded normally, since no subagents).
   - Advance time by `STALE_ACTIVE_MS + 1000`.
   - Call `sweepStaleSessions()`.
   - Expect the task's `lastAgentStatus` to remain `"responded"` (unchanged, no double-apply).
   - Broadcast count for that task should increase by exactly 1 from the original Stop (not 2).

4. **`case 10: stale-active sweep does NOT fire if activity is fresh`**
   - Fire: `UserPromptSubmit` → `working` → `PostToolUse` (refreshes `lastHookEventAt`).
   - Advance time by `STALE_ACTIVE_MS - 5000` (55s).
   - Call `sweepStaleSessions()`.
   - Expect the task's `lastAgentStatus` to still be `"working"` (unchanged).

5. **`case 11: pending-stop branch still wins over stale-active branch`**
   - Fire: `UserPromptSubmit` → `working` → `SubagentStart (tool-a)` → `Stop` (dropped, `pendingStopAt` set).
   - Advance time by `STALE_STOP_MS + 1000` (16s, well under 60s).
   - Call `sweepStaleSessions()`.
   - Expect the task's `lastAgentStatus` to be `"responded"` (fired by the pending-stop branch, not the stale-active branch).

### Add a new describe block: `"createHookRelay — AgentDetector gone-bridge"`

1. **`case bridge-1: notifyAgentDetectorGone force-closes active task`**
   - Fire: `UserPromptSubmit` → `working` on pane `pane-1`.
   - Call `ctx.notifyAgentDetectorGone("pane-1")`.
   - Expect the task linked to that session has `lastAgentStatus === "responded"`.
   - Expect `activeSubagents` on the session state is cleared.

2. **`case bridge-2: notifyAgentDetectorGone is a no-op on unknown pane`**
   - Call `ctx.notifyAgentDetectorGone("pane-does-not-exist")`.
   - No task updates should occur. `broadcastTask` should not be called.

3. **`case bridge-3: notifyAgentDetectorGone is a no-op if task already terminal`**
   - Fire: `UserPromptSubmit` → `working` → `Stop` (task → responded).
   - Call `ctx.notifyAgentDetectorGone("pane-1")`.
   - Expect the task `lastAgentStatus` is still `"responded"` (unchanged, not double-applied). Broadcast count for that task should be 1 (from the original Stop, not 2).

4. **`case bridge-4: notifyAgentDetectorGone clears pendingStopAt too`**
   - Fire: `UserPromptSubmit` → `working` → `SubagentStart (tool-a)` → `Stop` (dropped, `pendingStopAt` set).
   - Call `ctx.notifyAgentDetectorGone("pane-1")`.
   - Expect `state.pendingStopAt` is `null` and `state.activeSubagents.size` is `0`.
   - Expect task `lastAgentStatus === "responded"`.

### Verification

All existing tests in `relay-subagent-tracking.test.ts` must continue to pass. Run the full test suite for the electron package.

## Files to touch

- `electron/__tests__/relay-subagent-tracking.test.ts` — add the new cases and (optionally) rename the second describe block. Import `STALE_ACTIVE_MS` from `../hook-relay`.
