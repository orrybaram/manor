---
title: Bridge AgentDetector gone-transition to force-close task
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Bridge AgentDetector gone-transition to force-close task

When the daemon's `AgentDetector` transitions to "gone" (`{ status: "idle", kind: null }`), immediately force-apply Stop on the linked task if it's still flagged active. This turns AgentDetector's existing process-death detection into near-instant task-level recovery, instead of waiting 60s for the sweep.

## Implementation

### 1. Add a bridge helper in `electron/hook-relay.ts`

Add a method on `HookRelayContext` that encapsulates the bridge logic so it's unit-testable alongside the rest of the relay. Inside `createHookRelay()`:

```ts
function notifyAgentDetectorGone(paneId: string): void {
  const rootSession = paneRootSessionMap.get(paneId);
  if (!rootSession) return;
  const task = taskManager.getTaskBySessionId(rootSession);
  if (!task) return;
  if (
    task.lastAgentStatus !== "thinking" &&
    task.lastAgentStatus !== "working"
  ) {
    return;
  }
  console.debug(
    `[task-lifecycle] bridge: AgentDetector gone on pane ${paneId} → force-apply Stop on ${rootSession}`,
  );
  const state = sessionStateMap.get(rootSession);
  if (state) {
    state.activeSubagents.clear();
    state.pendingStopAt = null;
  }
  applyStopForSession(rootSession);
}
```

Expose it on `HookRelayContext`:

```ts
export interface HookRelayContext {
  relay: RelayFn;
  sessionStateMap: Map<string, SessionState>;
  paneRootSessionMap: Map<string, string>;
  applyStopForSession: (sessionId: string) => void;
  sweepStaleSessions: () => void;          // from ticket 1
  notifyAgentDetectorGone: (paneId: string) => void;  // NEW
}
```

Return it from `createHookRelay()`.

### 2. Wire the bridge in `electron/app-lifecycle.ts`

- Destructure `notifyAgentDetectorGone` from `createHookRelay()`.
- Inside the stream event handler's `case "agentStatus":` block (~line 136-162), after the existing `pty-agent-status-...send(...)` and title-update logic, add:

  ```ts
  if (event.agent.status === "idle" && event.agent.kind === null) {
    notifyAgentDetectorGone(event.sessionId);
  }
  ```

  Note: `event.sessionId` here is the **paneId** (see `electron/preload.ts:33-34` — the per-pane IPC channel `pty-agent-status-${paneId}` is what the renderer subscribes to). `notifyAgentDetectorGone` takes a paneId and resolves to the root session internally.

Do NOT forward the transition unconditionally — only fire the bridge when both `status === "idle"` AND `kind === null`, which is the unambiguous "gone" signal from `AgentDetector.transitionToGone()`.

### 3. Verification

- Typecheck + build passes.
- Manual smoke (optional, not blocking verification): start Claude, send a prompt, kill the Claude process (`pkill -9 claude`), watch the task `AgentDot` in the sidebar recover within a few seconds (not after 60s).

## Files to touch

- `electron/hook-relay.ts` — add `notifyAgentDetectorGone` to `HookRelayContext` and implement it.
- `electron/app-lifecycle.ts` — destructure and invoke the bridge from the `agentStatus` stream case.
