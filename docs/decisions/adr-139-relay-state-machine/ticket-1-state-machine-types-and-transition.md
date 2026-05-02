---
title: Define SessionState/Effect types and pure transitionSession function
status: done
priority: high
assignee: opus
blocked_by: []
---

# Define SessionState/Effect types and pure transitionSession function

Create `electron/hook-relay-transition.ts`. This ticket lands the types and a fully-implemented `transitionSession` function. No wiring yet — `hook-relay.ts` is untouched, no tests change.

## What to do

1. **Types** (top of file):

```ts
import type { AgentHookEvent } from "./agent-hook-events";
import type { AgentStatus, AgentKind } from "./terminal-host/types";
import type { TaskInfo } from "./task-persistence";

export type SessionPhase = "active" | "pendingStop" | "responded";

export interface SessionState {
  phase: SessionPhase;
  activeSubagents: Set<string>;
  lastHookEventAt: number;
}

export type Effect =
  | { kind: "RelayAgentHook"; paneId: string; status: AgentStatus; agentKind: AgentKind }
  | { kind: "SetPaneRoot"; paneId: string; sessionId: string }
  | { kind: "DeletePaneRoot"; paneId: string }
  | { kind: "ForceCloseOldSession"; sessionId: string }
  | { kind: "DeleteSessionState"; sessionId: string }
  | { kind: "CreateTask"; sessionId: string; paneId: string; agentKind: AgentKind; status: AgentStatus }
  | { kind: "UpdateTaskActiveStatus"; sessionId: string; status: AgentStatus }
  | { kind: "ApplyStop"; sessionId: string }
  | { kind: "MarkCompleted"; sessionId: string }
  | { kind: "MarkError"; sessionId: string };

export interface TransitionContext {
  paneRootSession: string | null;
  existingTask: TaskInfo | null;
  nowMs: number;
}

export interface TransitionResult {
  state: SessionState | null;
  effects: Effect[];
}
```

2. **Function**: `transitionSession(state, event, context): TransitionResult`. Pure, exhaustive on `event.type`. No closures, no IO, no mutation of inputs (clone the `Set` on subagent additions/removals).

3. **Behavior parity**: read today's `electron/hook-relay.ts` `relay()` function carefully (lines ~210–410) and reproduce its branching as transition cases. Specifically:
   - `SessionStart`: never relays to AgentDetector. If `paneRootSession` exists and differs from `event.sessionId`, emit `ForceCloseOldSession` for the old root + `DeletePaneRoot` + `DeleteSessionState`. Then emit `SetPaneRoot`. Returns `state: null` (no session-state change for the new sessionId yet — created lazily on first non-SessionStart event).
   - Non-SessionStart with `sessionId === null`: emit `RelayAgentHook` only (today's behavior — no task persistence).
   - Subagent-session detection: if `paneRootSession` exists and differs from `event.sessionId` (and `eventType !== "SessionStart"`), emit only `RelayAgentHook` and stop. Subagent events for non-root sessions don't update task state.
   - Late-active guard: if existing task `lastAgentStatus === "responded"` and event is active-status (`thinking | working | requires_input`) and not `UserPromptSubmit` and not `SessionStart`, return `{ state, effects: [] }` (drop entirely). This is the recently-added invariant.
   - SubagentStart: clone `state.activeSubagents`, add `toolUseId ?? __fallback_${size}`. Then proceed to active-task-update path.
   - SubagentStop: clone the set, remove `toolUseId` (or first if null). Then proceed.
   - Active-status events on existing/new task: emit `RelayAgentHook` + `CreateTask` (if no existingTask) or `UpdateTaskActiveStatus` (if existing).
   - `Stop`: if `activeSubagents.size > 0`, set phase to `pendingStop` (no `ApplyStop` effect). Else emit `ApplyStop` and phase becomes `responded`.
   - `SessionEnd`: if phase was `pendingStop`, emit `ApplyStop` first then `MarkCompleted`. Else just `MarkCompleted`. Clear state (`state: null`). Emit `DeletePaneRoot`.
   - `StopFailure`: emit `MarkError`. Clear state.
   - The `hasBeenActive` filter (drop terminal events when never active) is preserved: today the relay returns early for `Stop`/`SessionEnd`/`StopFailure` if `!sessionState.hasBeenActive`. With the new model, `state: null` (never seen an active event) means we drop these events.

4. **Effect ordering matters.** Match today's call order exactly:
   - For active events: `RelayAgentHook` first, then task creation/update.
   - For SessionStart with replacement: log/force-close happens before `SetPaneRoot`.
   - For SessionEnd with pendingStop: `ApplyStop` before `MarkCompleted`.

5. **Do not import** from `hook-relay.ts`. Constants (`STUCK_ACTIVE`, `ACTIVE_STATUSES`) can be re-defined locally or moved to a small shared internal module.

## Files to touch

- **Create:** `electron/hook-relay-transition.ts` (~400 LOC)
- **Read for reference:** `electron/hook-relay.ts`, `electron/agent-hook-events.ts`, `electron/task-persistence.ts` (`TaskInfo`)

## Verification

- `bun x tsc --noEmit -p tsconfig.electron.json` — file must typecheck.
- No tests added in this ticket. Behaviour is exercised by ticket 2 (integration) and ticket 3 (transition-table tests).
- `electron/hook-relay.ts` must remain unchanged after this ticket.

## Notes

opus-assigned because this is a careful state-machine port that has to preserve effect ordering across 12 events × 3 phases. Mistakes here cost in ticket 2's regression triage. Read `relay()` end-to-end before writing a line.
