---
title: Add stale-Stop safety net with session inactivity sweep
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add stale-Stop safety net with session inactivity sweep

Guarantee that a dropped `Stop` event recovers within ~15 seconds of session inactivity, even if subagent events are permanently lost. Ticket 1 fixes the common cases; this ticket adds a last-line-of-defense so the sidebar spinner always clears.

## Mechanism

When a `Stop` is dropped because `activeSubagents.size > 0`, record a `pendingStopAt` timestamp on the session. Track `lastHookEventAt` on every hook arrival. A periodic sweep checks: if a session has a pending Stop AND no hook events have arrived for >15s, force-apply the Stop as if the subagent queue had drained normally.

## Files to touch

### `electron/app-lifecycle.ts`

**Extend `SessionState`** (the interface modified in ticket 1):

```ts
interface SessionState {
  activeSubagents: Set<string>;
  hasBeenActive: boolean;
  pendingStopAt: number | null;
  lastHookEventAt: number;
}
```

**`getOrCreateSessionState`** — initialize `pendingStopAt: null`, `lastHookEventAt: Date.now()`.

**Top of the relay callback** — after getting/creating `sessionState`, update `lastHookEventAt`:

```ts
const sessionState = getOrCreateSessionState(sessionId);
sessionState.lastHookEventAt = Date.now();
```

**Stop gate** — when dropping, record `pendingStopAt`:

```ts
if (eventType === "Stop") {
  if (sessionState.activeSubagents.size > 0) {
    sessionState.pendingStopAt = Date.now();
    return;
  }
  // Clear any pending marker when we apply a real Stop
  sessionState.pendingStopAt = null;
  // … existing "responded" persistence code
}
```

**Extract a helper** — the task-update + notification + broadcast code inside the `Stop` branch is about to be called from two places (normal Stop, sweep recovery). Pull it into a local function inside `app.whenReady`'s scope, above `setRelay`:

```ts
function applyStopForSession(sessionId: string): void {
  const task = taskManager.getTaskBySessionId(sessionId);
  if (!task) return;
  const prevStatus = task.lastAgentStatus;
  const updated = taskManager.updateTask(task.id, {
    lastAgentStatus: "responded",
    status: "active",
  });
  if (updated) {
    unseenRespondedTasks.add(updated.id);
    maybeSendNotification(updated, prevStatus, "responded");
    broadcastTask(updated);
  }
}
```

Rewrite the existing `Stop` handler body to call `applyStopForSession(sessionId)` after clearing `pendingStopAt`. Preserve the existing subagent gate guard above it.

**Sweep timer** — immediately after `agentHookServer.setRelay(...)`:

```ts
const STALE_STOP_MS = 15_000;
const SWEEP_INTERVAL_MS = 10_000;

const staleStopSweep = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, state] of sessionStateMap) {
    if (
      state.pendingStopAt !== null &&
      now - state.lastHookEventAt > STALE_STOP_MS
    ) {
      console.debug(
        `[task-lifecycle] stale-stop sweep: forcing responded on session ${sessionId} ` +
          `(activeSubagents=${state.activeSubagents.size}, idle=${now - state.lastHookEventAt}ms)`,
      );
      state.activeSubagents.clear();
      state.pendingStopAt = null;
      applyStopForSession(sessionId);
    }
  }
}, SWEEP_INTERVAL_MS);

app.on("before-quit", () => {
  clearInterval(staleStopSweep);
});
```

Place the `before-quit` listener near the existing `agentHookServer.stop()` call to keep lifecycle teardown in one place.

## Verification

- `npm run typecheck` passes.
- `npm run build` passes.
- Manually trigger stuck state (can be verified by ticket 3 tests).

## Out of scope

- Tests (ticket 3).

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-130): add stale-Stop safety net with inactivity sweep"

Do not push.
