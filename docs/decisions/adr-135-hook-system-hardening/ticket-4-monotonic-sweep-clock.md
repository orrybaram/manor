---
title: Use monotonic clock for sweep idle math
status: in-progress
priority: high
assignee: opus
blocked_by: []
---

# Use monotonic clock for sweep idle math

All three sweep branches in `electron/hook-relay.ts:301-359` compare `Date.now()` differences. After a laptop suspend/resume, every active task's "idle" suddenly exceeds the threshold and the sweep force-completes everything alive on first wake. Branch 3 (orphan-task) does the same with `Date.parse(task.activatedAt)`.

See ADR-135 §"Change 4" for full reasoning.

## What to change

Switch `SessionState.lastHookEventAt` to a monotonic millisecond timestamp from `process.hrtime.bigint()`. Branches 1 and 2 then use monotonic deltas only.

```ts
function nowMonoMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

interface SessionState {
  activeSubagents: Set<string>;
  hasBeenActive: boolean;
  pendingStopAt: number | null;   // monotonic ms
  lastHookEventAt: number;        // monotonic ms
}
```

Update the producers (lines 105, 186, 264) to call `nowMonoMs()` and the consumers (lines 304, 307, 320) to compute `nowMonoMs() - lastHookEventAt`.

For Branch 3 (orphan-task sweep), `task.activatedAt` is a wall-clock ISO string and must remain so for display + cross-restart durability. Add a per-process "monotonic floor" and clamp:

```ts
// Captured once when createHookRelay() is called:
const RELAY_BOOT_MONO_MS = nowMonoMs();
const RELAY_BOOT_WALL_MS = Date.now();

function taskMonotonicAgeMs(task: TaskInfo): number {
  if (!task.activatedAt) return 0;
  const wallAge = Date.now() - Date.parse(task.activatedAt);
  if (Number.isNaN(wallAge) || wallAge < 0) return 0;
  // Time the relay has been running, monotonically:
  const monoSinceBoot = nowMonoMs() - RELAY_BOOT_MONO_MS;
  // Time apparent on the wall clock since boot:
  const wallSinceBoot = Date.now() - RELAY_BOOT_WALL_MS;
  // If the wall clock jumped (suspend), wall - mono > 0; clamp wallAge by the relay's actual run-time.
  if (wallSinceBoot > monoSinceBoot) {
    return Math.min(wallAge, monoSinceBoot);
  }
  return wallAge;
}
```

Branch 3 then uses `taskMonotonicAgeMs(task)` instead of `nowMs - activatedMs`. After a suspend, tasks that were created mid-session have an apparent wall age greater than the monotonic time since the relay booted, which clamps to the monotonic value — i.e. the sweep waits the full `STALE_ACTIVE_MS` of *real* run-time, not wall time, before acting.

For the production `app-lifecycle.ts` integration, ensure `RELAY_BOOT_*` are captured in the closure inside `createHookRelay` (lines 85-94), not at module scope.

## Files to touch

- `electron/hook-relay.ts` — add `nowMonoMs`, capture boot timestamps in the factory closure, switch SessionState fields and Branches 1/2 to mono, clamp Branch 3 with `taskMonotonicAgeMs`.

## Tests

Extend `electron/__tests__/relay-subagent-tracking.test.ts`:

1. Inject a fake clock pair (`monoClock` and `wallClock`) into the factory (this requires exposing the clocks as deps — make the change minimal). Existing tests get default real clocks via shim.
2. Suspend simulation: advance `wallClock` by 60 minutes without advancing `monoClock`. Run sweep. No active task should be force-completed.
3. After a real (mono) 70-second idle, sweep does fire as before (regression check on Branches 1/2).
4. Branch 3 with wall clock jumped — task `activatedAt` shows the task is "an hour old" via wall, but monotonic age is 5 seconds; sweep is a no-op.

## Notes

This is the largest change in ADR-135. Opus assignee because the boot/clamp interaction needs care — getting the monotonic floor wrong silently delays or skips legitimate sweep firings.
