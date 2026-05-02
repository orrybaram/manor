---
title: Implement applyEffects and rewire createHookRelay's relay()
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Implement applyEffects and rewire createHookRelay's relay()

Create `electron/hook-relay-effects.ts` with the effect applier, then replace the imperative body of `relay()` in `electron/hook-relay.ts` with a thin "fetch state → call transition → apply effects" pipeline.

The existing 100 tests in `electron/__tests__/relay-subagent-tracking.test.ts` and `electron/__tests__/agent-hooks.test.ts` MUST pass unchanged after this ticket. They are the integration safety net.

## What to do

### Part A — `electron/hook-relay-effects.ts`

```ts
import type { Effect } from "./hook-relay-transition";
import type { ITaskManager, HookRelayDeps } from "./hook-relay";

export interface EffectApplierDeps {
  taskManager: ITaskManager;
  relayAgentHook: HookRelayDeps["relayAgentHook"];
  getPaneContext: HookRelayDeps["getPaneContext"];
  unseenRespondedTasks: Set<string>;
  unseenInputTasks: Set<string>;
  broadcastTask: HookRelayDeps["broadcastTask"];
  maybeSendNotification: HookRelayDeps["maybeSendNotification"];
  paneRootSessionMap: Map<string, string>;
  applyStopForSession: (sessionId: string) => void;
}

export function applyEffects(effects: Effect[], deps: EffectApplierDeps): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case "RelayAgentHook": ...
      case "SetPaneRoot": ...
      case "DeletePaneRoot": ...
      case "ForceCloseOldSession": ...   // calls deps.applyStopForSession
      case "DeleteSessionState": ...     // no-op here; handled by relay() outer code
      case "CreateTask": ...             // taskManager.createTask + activatedAt update + unseenInputTasks
      case "UpdateTaskActiveStatus": ... // taskManager.updateTask + maybeSendNotification + broadcastTask
      case "ApplyStop": deps.applyStopForSession(effect.sessionId); break;
      case "MarkCompleted": ...          // taskManager.updateTask({ lastAgentStatus: "complete", status: "completed", completedAt }) + unseen* mutations + broadcastTask
      case "MarkError": ...              // similar to MarkCompleted but lastAgentStatus: status (passed through), status: "error"
    }
  }
}
```

Reproduce the exact mutation sequence from today's `relay()`:
- `CreateTask`: `taskManager.createTask({...})` then `taskManager.updateTask(task.id, { activatedAt: now })`. If `status === "requires_input"`, `unseenInputTasks.add(task.id)`. Then `broadcastTask`.
- `UpdateTaskActiveStatus`: `taskManager.updateTask(task.id, { lastAgentStatus, status: "active", ...(activatedAt ? {} : { activatedAt: now }) })`. If `requires_input`, `unseenInputTasks.add`. Then `maybeSendNotification(task, prevStatus, status)`. Then `broadcastTask`.
- `MarkCompleted`: re-fetch task, `taskManager.updateTask(task.id, { lastAgentStatus: "complete", status: "completed", completedAt: ... })`. Then `unseenRespondedTasks.delete`, `unseenInputTasks.delete`, `broadcastTask`.
- `MarkError`: re-fetch task, `taskManager.updateTask(task.id, { lastAgentStatus: status, status: "error", completedAt: ... })`. Then `unseenRespondedTasks.delete`, `unseenInputTasks.delete`, `broadcastTask`.

`DeleteSessionState` is a signal effect handled by the outer `relay()` function (which owns the `sessionStateMap`). The applier ignores it.

### Part B — Rewire `electron/hook-relay.ts`

Replace the body of the existing `relay()` function with:

```ts
function relay(event: AgentHookEvent): void {
  const sessionId = event.sessionId;
  const state = sessionId ? sessionStateMap.get(sessionId) ?? null : null;
  const existingTask = sessionId ? taskManager.getTaskBySessionId(sessionId) : null;

  const result = transitionSession(state, event, {
    paneRootSession: paneRootSessionMap.get(event.paneId) ?? null,
    existingTask,
    nowMs: nowMonoMs(),
  });

  if (sessionId) {
    if (result.state) sessionStateMap.set(sessionId, result.state);
    else sessionStateMap.delete(sessionId);
  }

  applyEffects(result.effects, {
    taskManager,
    relayAgentHook,
    getPaneContext,
    unseenRespondedTasks,
    unseenInputTasks,
    broadcastTask,
    maybeSendNotification,
    paneRootSessionMap,
    applyStopForSession,
  });
}
```

Delete the imperative body. Keep `applyStopForSession`, `getOrCreateSessionState` (unused after this ticket — DELETE if no callers remain), `sweepStaleSessions`, `notifyAgentDetectorGone` as-is. Sweeps and the bridge still mutate state directly per ADR — out of scope.

The header doc block in `hook-relay.ts` already catalogues the responded-session invariant (added in fb59b33). Add a one-line pointer to the new transition module:

```
 * Transition logic lives in `hook-relay-transition.ts`; effect application
 * in `hook-relay-effects.ts`. The factory below wires them to the
 * persistent state (sessionStateMap, paneRootSessionMap) and the deps.
```

## Files to touch

- **Create:** `electron/hook-relay-effects.ts` (~150 LOC)
- **Modify:** `electron/hook-relay.ts` — replace `relay()` body, update header doc, possibly delete dead `getOrCreateSessionState`.
- **Read for reference:** `electron/hook-relay-transition.ts` (from ticket 1), `electron/__tests__/relay-subagent-tracking.test.ts` (to verify which call orders matter).

## Verification

- `bun x tsc --noEmit -p tsconfig.electron.json` — clean (modulo pre-existing errors not in `hook-relay*` files).
- `bun x vitest run electron/__tests__/relay-subagent-tracking.test.ts electron/__tests__/agent-hooks.test.ts` — all 100 tests pass.
- `bun x vitest run electron/` — no new failures vs `main`.

## Notes

opus because the effect applier must reproduce today's mutation sequence exactly — there are 100 tests that pin specific orderings (broadcast vs notify, unseen-set timing, session-state deletion timing). One subtle off-by-one in effect ordering and a dozen tests fail with cryptic diffs.

If a test fails after this ticket, do NOT change the test. The transition function (ticket 1) or the applier got the order wrong; fix that.

## Notes from ticket 1 implementer (must read)

The ticket-1 author flagged two design points the applier needs to handle:

1. **`ForceCloseOldSession` is emitted unconditionally on SessionStart-with-replacement.** The transition function does not pre-check whether the old session was force-closeable. The applier MUST replicate today's gating: only call `applyStopForSession(oldSessionId)` when:
   - the old session has a task (`getTaskBySessionId(oldSessionId) != null`), AND
   - the task's `lastAgentStatus` is stuck-active (`thinking | working | requires_input`), AND
   - the old session "had been active" — for which the new model treats `state !== null` as the proxy (lazy-creation means a session that never received a non-SessionStart event has no state). The applier can read sessionStateMap to check this, OR rely on the order: `ForceCloseOldSession` is followed by `DeleteSessionState`, and the outer `relay()` mutates `sessionStateMap` BEFORE calling `applyEffects`. Re-read order carefully when wiring.

2. **`hasBeenActive` is no longer a field on `SessionState`.** It's encoded as "state exists." The applier should not look for `hasBeenActive` anywhere. Terminal events on a never-active session are filtered by the transition function (returns `state: null`, no effects), so the applier never sees them.
