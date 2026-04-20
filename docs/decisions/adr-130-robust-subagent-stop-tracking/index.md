---
type: adr
status: proposed
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

# ADR-130: Robust subagent Stop tracking + stuck-task safety net

## Context

Tasks sometimes get stuck showing a spinner in the sidebar even after the agent has clearly finished responding. Observed with Claude Code agents.

**Current behavior** (`electron/app-lifecycle.ts:480-499`):

```ts
if (eventType === "Stop") {
  if (sessionState.subagentCount > 0) {
    return;  // drop — assumed to be a subagent's Stop
  }
  // … persist lastAgentStatus: "responded"
}
```

**Why the gate exists** (ADR-033): Claude Code subagents fire `Stop` hook events with the **same `session_id` as the parent session**. So we need a way to distinguish "subagent's intermediate Stop" from "parent's real Stop". The existing design counts `SubagentStart` (+1) and `SubagentStop` (-1); any `Stop` seen while `subagentCount > 0` is assumed to be a subagent's Stop and ignored.

**The bug**: the count can desync permanently. If a `SubagentStop` hook fails to fire (hook script timeout, curl failure, process crash between the two events, duplicate `SubagentStart`, Claude internal drop), `subagentCount` stays > 0 forever. **All subsequent parent `Stop` events are silently dropped**, and `task.lastAgentStatus` freezes on the last active value (`thinking`/`working`). The sidebar spinner never clears.

Once in this stuck state, nothing recovers it — `SessionEnd` eventually transitions to `completed` when the user closes the terminal, but during normal "agent responded, user reads response, sends next prompt" flow the task never shows the responded dot.

Two independent weaknesses:

1. **Count-based tracking is brittle**: it assumes perfectly balanced hook firings. Real-world hook delivery (HTTP curl from shell script, 2s connect timeout, fire-and-forget) drops events.
2. **No recovery**: once the count desyncs, there is no mechanism to escape the stuck state mid-session.

## Decision

Fix both weaknesses:

### 1. Track subagent identities (not a count)

Replace `subagentCount: number` with `activeSubagents: Set<string>`. Extract the subagent's unique identifier (Claude's `tool_use_id` for the Task invocation) from the hook payload and forward it to the relay. `SubagentStart` adds the id to the set; `SubagentStop` removes it.

This makes the gate idempotent:
- Duplicate `SubagentStart` for the same id → no-op (Set semantics).
- `SubagentStop` for an unknown id → no-op (can't go negative).
- The gate checks `activeSubagents.size > 0`.

This alone fixes the *duplicate SubagentStart* and *unmatched SubagentStop* cases. It does not fix the *dropped SubagentStop* case (id stays in the set forever). That's what the safety net is for.

**Changes**:
- `electron/agent-hooks.ts` (hook script): extract `tool_use_id` from the hook payload JSON alongside `session_id`. Forward as `toolUseId` URL param.
- `electron/agent-hooks.ts` (HTTP handler): read `toolUseId` from query params, pass it to the relay callback.
- `electron/app-lifecycle.ts`: relay signature grows a `toolUseId: string | null` param. `SessionState.subagentCount` → `activeSubagents: Set<string>`. On `SubagentStart` with a `toolUseId`, `add`. On `SubagentStop` with a `toolUseId`, `delete`. If `toolUseId` is null (unknown agent, missing payload field), fall back to counting via a synthesized id (`"__fallback_" + activeSubagents.size`) so behavior degrades gracefully.
- Stop gate: `if (sessionState.activeSubagents.size > 0) return;`

### 2. Stale-Stop safety net

When a `Stop` is dropped because `activeSubagents` is non-empty, remember it. If no further hook activity arrives on that session for a stale window (15s), assume the subagent events were lost and apply the pending Stop.

**State added to `SessionState`**:
- `pendingStopAt: number | null` — timestamp of the most recent dropped `Stop`, or `null` if none pending.
- `lastHookEventAt: number` — timestamp of the most recent hook event (any type), updated at the top of the relay callback.

**Sweep**: add a 10s-interval timer alongside the existing relay setup. For each session in `sessionStateMap`:
- If `pendingStopAt !== null` AND `Date.now() - lastHookEventAt > 15000`:
  - Clear `activeSubagents`, clear `pendingStopAt`.
  - Apply the Stop: update task `lastAgentStatus: "responded"`, broadcast, fire notification (same path as the normal Stop handler).

Any new hook event (including a late `SubagentStop` or new `UserPromptSubmit`) resets `lastHookEventAt`, deferring the sweep. This means the safety net only fires when the session has truly gone quiet — not during active subagent work.

**Changes**:
- `electron/app-lifecycle.ts`: extend `SessionState`. Add the sweep timer in `app.whenReady()` after `agentHookServer.start()`. Clear the interval on `app.on("before-quit")`.

### 3. Tests

- Unit tests for `SessionState` subagent Set behavior: add/remove, duplicate adds, remove-unknown, Stop gating.
- Unit test for the safety net: simulate a `SubagentStart` without matching `SubagentStop`, followed by a `Stop`, followed by 16s of silence → task transitions to `responded`.
- Hook script extraction test: given a sample Claude hook payload with `tool_use_id`, the server receives the id.

## Consequences

**Better**:
- Stuck-spinner bug fixed for both the duplicate-start and dropped-stop cases.
- Subagent tracking is idempotent, robust to duplicate/missing hooks.
- Safety net guarantees recovery within 15s even if both fixes above fail.
- Users trust the sidebar status indicator again.

**Tradeoffs**:
- Hook script parses one more field — marginal shell overhead (single `grep -oE`).
- SessionState grows by a Set and two numbers per session — trivial memory.
- New 10s-interval timer. One sweep pass per active session, O(sessions). Negligible.
- Safety net has a 15s lag before unsticking. Acceptable — fresh sessions will almost always get the real Stop hook and fire instantly; the safety net is purely for the failure case.

**Risks**:
- If Claude's hook payload doesn't include `tool_use_id` for `SubagentStart`/`SubagentStop`, the fallback degrades to the old count-based behavior (now expressed via synthesized ids in a Set, same failure mode). The safety net still catches it.
- A long-running subagent (>15s) that somehow stops emitting hook events entirely would be incorrectly marked `responded`. In practice, active Claude subagents emit `PostToolUse`/`PreToolUse` frequently (updating `lastHookEventAt`), so this shouldn't fire during real work.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
