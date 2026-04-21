---
title: Extend stale sweep with stale-active branch
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Extend stale sweep with stale-active branch

Extend the ADR-130 stale-Stop sweep to also cover the case where `Stop` never arrives at all. Move the sweep body from `app-lifecycle.ts` into `hook-relay.ts` so both branches are unit-testable.

## Implementation

### 1. `electron/hook-relay.ts`

- Add a new exported constant alongside `STALE_STOP_MS` and `SWEEP_INTERVAL_MS`:

  ```ts
  export const STALE_ACTIVE_MS = 60_000;
  ```

- Add `sweepStaleSessions: () => void` to `HookRelayContext`.

- Inside `createHookRelay()`, define the sweep function. It closes over `sessionStateMap`, `taskManager`, and `applyStopForSession`:

  ```ts
  function sweepStaleSessions(): void {
    const now = Date.now();
    for (const [sessionId, state] of sessionStateMap) {
      const idle = now - state.lastHookEventAt;

      // Branch 1 (ADR-130): Stop received but blocked by active subagents
      if (state.pendingStopAt !== null && idle > STALE_STOP_MS) {
        console.debug(
          `[task-lifecycle] stale-stop sweep: forcing responded on ${sessionId} ` +
            `(activeSubagents=${state.activeSubagents.size}, idle=${idle}ms)`,
        );
        state.activeSubagents.clear();
        state.pendingStopAt = null;
        applyStopForSession(sessionId);
        continue;
      }

      // Branch 2 (ADR-131): Stop never arrived — force close if the task
      // is still flagged active and the session has gone quiet.
      if (state.hasBeenActive && idle > STALE_ACTIVE_MS) {
        const task = taskManager.getTaskBySessionId(sessionId);
        if (
          task &&
          (task.lastAgentStatus === "thinking" ||
            task.lastAgentStatus === "working")
        ) {
          console.debug(
            `[task-lifecycle] stale-active sweep: forcing responded on ${sessionId} ` +
              `(lastAgentStatus=${task.lastAgentStatus}, idle=${idle}ms)`,
          );
          state.activeSubagents.clear();
          applyStopForSession(sessionId);
        }
      }
    }
  }
  ```

- Return `sweepStaleSessions` from `createHookRelay()` as part of `HookRelayContext`.

Do NOT change the existing `applyStopForSession` or `relay` behavior.

### 2. `electron/app-lifecycle.ts`

- Destructure `sweepStaleSessions` from `createHookRelay()`.
- Replace the inline sweep body in the `setInterval` at ~line 357-373 with a single call:

  ```ts
  const staleStopSweep = setInterval(() => {
    sweepStaleSessions();
  }, SWEEP_INTERVAL_MS);
  ```

- Keep the `clearInterval(staleStopSweep)` on `before-quit`.
- The import of `STALE_STOP_MS` from `./hook-relay` can be dropped if it's no longer referenced in this file. Keep the `SWEEP_INTERVAL_MS` import.

### 3. Verification

Run typecheck + build via the verifier. The existing relay test suite should still pass unchanged (Branch 1 behavior is unchanged).

## Files to touch

- `electron/hook-relay.ts` — add `STALE_ACTIVE_MS` export, add `sweepStaleSessions` method on `HookRelayContext`.
- `electron/app-lifecycle.ts` — destructure the new method, replace inline sweep body with a single call.
