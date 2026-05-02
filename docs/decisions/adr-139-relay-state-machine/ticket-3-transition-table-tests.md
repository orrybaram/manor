---
title: Add transition-table tests for the pure transition function
status: done
priority: medium
assignee: haiku
blocked_by: [1, 2]
---

# Add transition-table tests for the pure transition function

Once the state machine is in place and the integration suite passes (ticket 2 verification), add a focused test suite for `transitionSession` itself. These are pure-function tests — no relay, no factory, no fakes beyond a synthetic `TaskInfo`.

The integration suite covers behaviour under realistic event sequences. This new suite covers the transition table cell-by-cell so future contributors can read invariants directly.

## What to do

Create `electron/__tests__/hook-relay-transition.test.ts`. Structure:

```ts
import { describe, it, expect } from "vitest";
import { transitionSession, type SessionState } from "../hook-relay-transition";
import type { AgentHookEvent } from "../agent-hook-events";
import type { TaskInfo } from "../task-persistence";

const baseCtx = (extra: Partial<...> = {}) => ({
  paneRootSession: null,
  existingTask: null,
  nowMs: 1000,
  ...extra,
});

const activeState = (extra: Partial<SessionState> = {}): SessionState => ({
  phase: "active",
  activeSubagents: new Set(),
  lastHookEventAt: 0,
  ...extra,
});

const respondedTask = (sessionId: string): TaskInfo => ({
  // minimum fields for the function to read lastAgentStatus
  ...
  lastAgentStatus: "responded",
} as TaskInfo);
```

Cover at minimum:

### Group A — fresh session (state: null)

- SessionStart → emits `SetPaneRoot`, no `RelayAgentHook`, returns state: null.
- UserPromptSubmit → emits `RelayAgentHook` + `CreateTask` (paneRoot is set as side effect via the transition).
- Stop → no-op (never been active).
- SessionEnd → no-op.

### Group B — phase: active

- PostToolUse → `RelayAgentHook` + `UpdateTaskActiveStatus`, phase stays active.
- PreToolUse → same shape.
- Stop with no subagents → `RelayAgentHook` (status=responded? no — Stop doesn't relay to detector per current behaviour for `responded` status; verify) + `ApplyStop`, phase → responded.
- Stop with active subagents → no `ApplyStop`, phase → pendingStop.
- SubagentStart → state.activeSubagents grows; emits `RelayAgentHook` + task update.
- SubagentStop with known toolUseId → set shrinks.
- SubagentStop with unknown toolUseId → no-op on set.
- SessionStart with same paneRoot, different sessionId → `ForceCloseOldSession` + `DeleteSessionState` + `DeletePaneRoot` + `SetPaneRoot`. Returns state: null (old session is gone; new session has no state yet).

### Group C — phase: pendingStop

- SubagentStop that empties the set → `ApplyStop` fires deferred; phase → responded.
- Stop again → idempotent (no double-apply).
- SessionEnd → `ApplyStop` (drain) + `MarkCompleted`. State cleared.

### Group D — phase: responded (the late-event guard)

- PostToolUse on responded task → `effects: []`. State unchanged. (This is the recently-added invariant.)
- PreToolUse on responded task → `effects: []`.
- Notification (permission_prompt) on responded task → `effects: []`.
- UserPromptSubmit on responded task → `RelayAgentHook` + `UpdateTaskActiveStatus`, phase → active. (Legitimate next turn.)
- SessionEnd → `MarkCompleted`. State cleared.
- SessionStart → as Group B.

### Group E — sessionId === null

- Any event with `sessionId: null` → only `RelayAgentHook` (if applicable per SessionStart skip rule). No state changes.

### Group F — subagent session

- Event whose `sessionId` differs from `paneRootSession` (and not a SessionStart) → only `RelayAgentHook`. No state, no task work.

## Files to touch

- **Create:** `electron/__tests__/hook-relay-transition.test.ts` (~250 LOC)

## Verification

- `bun x vitest run electron/__tests__/hook-relay-transition.test.ts` — all pass.
- `bun x tsc --noEmit -p tsconfig.electron.json` — clean (modulo pre-existing).
- Existing 100 tests in `relay-subagent-tracking.test.ts` and `agent-hooks.test.ts` still pass (unchanged).

## Notes

haiku-assigned because writing transition-table tests is mechanical once the function exists — each cell is `expect(transitionSession(state, event, ctx)).toEqual({ state: ..., effects: [...] })`. The tricky judgement (which orderings, which cases matter) was already pinned by ticket 1's effect-emission code.

Don't over-engineer fixtures. Inline state/event objects at each test case. The point is reading "this case → this output" cell-by-cell.
