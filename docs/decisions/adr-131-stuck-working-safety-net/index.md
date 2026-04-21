---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-131: Safety net for stuck-working tasks when Stop never arrives

## Context

ADR-130 introduced a stale-Stop sweep that recovers tasks stuck in a "working" state after a `Stop` hook is dropped because `activeSubagents` desyncs. The sweep gate (`electron/hook-relay.ts:242-243`, `electron/app-lifecycle.ts:357-373`) is:

```ts
if (state.pendingStopAt !== null && now - state.lastHookEventAt > STALE_STOP_MS) {
  // force responded
}
```

**The remaining gap**: the sweep only fires when `pendingStopAt !== null` — i.e. the `Stop` event was received and blocked by non-empty `activeSubagents`. If `Stop`/`SessionEnd` **never arrive at all**, `pendingStopAt` stays `null` forever and the sweep skips the session.

Ways Stop can fail to arrive:

- Claude Code process crashes mid-response before the Stop hook fires.
- Hook script itself crashes or its `curl` to `localhost:AGENT_HOOK_PORT` fails (network transient, port rebind during app restart, 2s connect timeout hit under load).
- Parent shell kills the agent (Ctrl-C at the wrong moment, OS OOM killer, SIGKILL).
- User force-quits the workspace pane while the agent is mid-turn.

In every case, `task.lastAgentStatus` freezes at `"thinking"` or `"working"`. The TasksList `AgentDot` spinner keeps spinning forever — there is no recovery path short of `SessionEnd` firing, which only happens when the user closes the terminal.

Separately, `AgentDetector` (pane-level status, `electron/terminal-host/agent-detector.ts`) already detects process death via PID liveness (`sweepStalePids`) and via the foreground-process transitioning back to a shell — so the TabButton/ProjectItem `AgentDot` does recover. But the task-level status, which drives TasksList/TasksView, does not observe any of those signals.

Symptom: user reports the sidebar `AgentDot` keeps spinning even after the task has been long over. User asked for "a better way to detect task doneness, maybe introduce polling if necessary."

## Decision

Two independent safety nets, both feeding the existing `applyStopForSession()` terminal path.

### 1. Extend the stale-sweep with a "Stop never arrived" branch

Add `STALE_ACTIVE_MS = 60_000` alongside the existing `STALE_STOP_MS = 15_000`. The active window is longer than the pending-stop window because we have less evidence the agent is actually done — we don't want to cut short a genuinely slow tool call (Bash with a long-running command, WebFetch on a slow endpoint).

Inside the sweep, after the existing pending-Stop branch, add:

```ts
if (state.hasBeenActive && idle > STALE_ACTIVE_MS) {
  const task = taskManager.getTaskBySessionId(sessionId);
  if (task && (task.lastAgentStatus === "thinking" || task.lastAgentStatus === "working")) {
    state.activeSubagents.clear();
    applyStopForSession(sessionId);
  }
}
```

The `task.lastAgentStatus` check guards against re-applying `responded` to an already-terminal task. `hasBeenActive` mirrors the existing guard so we never force-close a session that never genuinely started.

While extracting, move the sweep implementation from the inline `setInterval` callback in `app-lifecycle.ts` into `createHookRelay()` as a `sweepStaleSessions()` method on the returned `HookRelayContext`. This matches the existing `applyStopForSession` export and lets the new branch be unit-tested alongside the existing one in `electron/__tests__/relay-subagent-tracking.test.ts`. The `setInterval` in `app-lifecycle.ts` just calls `ctx.sweepStaleSessions()`.

### 2. Bridge `AgentDetector` gone-transition to force-apply Stop

The `agentStatus` stream event in `app-lifecycle.ts:136-162` already fires every time the daemon's `AgentDetector` transitions. When it transitions to `{ status: "idle", kind: null }` (the `transitionToGone()` shape — set in `agent-detector.ts:349-362`), the pane-level indicator is effectively saying "the agent process is no longer running." If the linked task is still marked active, we can force-apply Stop immediately — no 60s wait.

Add to the `case "agentStatus"` handler, after the existing title-update logic:

```ts
if (event.agent.status === "idle" && event.agent.kind === null) {
  const rootSession = paneRootSessionMap.get(event.sessionId);
  if (rootSession) {
    const task = taskManager.getTaskBySessionId(rootSession);
    if (task && (task.lastAgentStatus === "thinking" || task.lastAgentStatus === "working")) {
      applyStopForSession(rootSession);
    }
  }
}
```

This turns AgentDetector's existing safety nets (PID sweep, shell-returned-to-foreground, no-foreground-process) into task-level recovery. Process-crash cases recover in seconds instead of 60s. The sweep-based branch above remains as a belt-and-suspenders fallback for cases where AgentDetector itself fails to detect gone (e.g. the agent process is alive but stuck, or PID tracking mis-attributes).

Both `paneRootSessionMap` and `applyStopForSession` are already exposed on `HookRelayContext` from ADR-130 — no new plumbing.

### 3. Tests

Extend `electron/__tests__/relay-subagent-tracking.test.ts`:

- New case: `hasBeenActive` session with no `Stop` ever fired. After `STALE_ACTIVE_MS + 1` of inactivity, `sweepStaleSessions()` transitions the task to `responded`.
- Task that was never active (no `hasBeenActive`): sweep does NOT fire even after 60s.
- Task already in terminal state (`complete`/`responded`): sweep does NOT re-apply.
- Bridge: construct a relay, fire a `SubagentStart`, then directly invoke the bridge logic with `{ status: "idle", kind: null }` for the same pane; expect task transitioned to `responded`. (The bridge lives in `app-lifecycle.ts` — for unit-testability, extract the bridge into a small helper on `HookRelayContext` so it can be tested without mounting the whole Electron stream pipeline.)

## Consequences

**Better**:
- Task-level `AgentDot` recovers from every known stuck-working cause.
- Process-crash recovery is near-instant (via AgentDetector bridge), not 60s.
- The new safety net composes with the existing one rather than replacing it.

**Tradeoffs**:
- 60s threshold means a genuinely slow single tool call (>60s of no hook activity) could be force-closed prematurely. Mitigation: Claude emits `PreToolUse`/`PostToolUse` around every tool, so the only at-risk case is a single tool that blocks silently for 60s+ mid-call. `Bash` calls typically stream output (resetting liveness via other paths), and the existing `PostToolUse` fires on completion. If this becomes a real problem, raise the threshold; 60s is a conservative default.
- The bridge introduces a dependency from the stream handler in `app-lifecycle.ts` onto `HookRelayContext` methods. Already holds a reference via the `createHookRelay()` return value — no new coupling.

**Risks**:
- False-positive bridge trigger: `AgentDetector` calls `transitionToGone` under more conditions than "process actually dead" (e.g. shell returns to foreground while agent is a backgrounded subprocess). In that edge case we'd mark a still-running agent as `responded`. Mitigation: only fire the bridge when `kind === null` (the full gone-transition), not intermediate states. The `hasBeenActive` check on the daemon side already prevents this during startup.
- Ordering: if `Stop` arrives between the bridge firing and the task update persisting, we could double-apply. `applyStopForSession` is idempotent on `lastAgentStatus: "responded"` (second call produces no visible change) so this is benign.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
