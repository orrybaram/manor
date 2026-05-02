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

# ADR-139: Reify the relay as a session-lifecycle state machine

## Context

The hook relay (`electron/hook-relay.ts`) is a state machine pretending to be a procedural callback. Its `relay()` function is ~250 lines of conditionals over `event.type` plus inline mutations across `sessionStateMap`, `paneRootSessionMap`, and the task persistence layer. Invariants — "responded must not re-activate except via UserPromptSubmit", "Stop is held while subagents active", "session state is gone after SessionEnd" — exist as imperative `if` guards inside one big function, not as types.

Every bug fix in this area in the last six months added another guard or sweep:

- ADR-130 — Stop tracker for active subagents
- ADR-131 — stuck-working safety net (idle sweep)
- ADR-132 — spinning-status recovery (orphan-task sweep)
- ADR-133 — namespace bug in sweep (sessionId vs paneId)
- ADR-135 — hook system hardening (sweep refactor, monotonic clock)
- ADR-138 ticket-4 — detector audit, recommended *audit, not rewrite*
- 03969ca — drop late active hooks on already-responded sessions

ADR-138's audit said the rewrite was non-trivial and deferred it. The recent typed-events refactor (9b62e0a) is the foundation: `event.type` is now an exhaustive sealed union (`AgentHookEvent`), ready for an exhaustive transition table.

## Decision

Split the relay's interior into a **pure transition function** + **effect applier**. The factory (`createHookRelay`) keeps its current external interface (`relay`, `sessionStateMap`, `paneRootSessionMap`, `applyStopForSession`, `sweepStaleSessions`, `notifyAgentDetectorGone`); only the body changes.

### 1. Pure transition function — `electron/hook-relay-transition.ts`

```ts
type SessionPhase = "active" | "pendingStop" | "responded";

interface SessionState {
  phase: SessionPhase;
  activeSubagents: Set<string>;
  lastHookEventAt: number;
}

type Effect =
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

function transitionSession(
  state: SessionState | null,
  event: AgentHookEvent,
  context: {
    paneRootSession: string | null;
    existingTask: TaskInfo | null;
    nowMs: number;
  },
): { state: SessionState | null; effects: Effect[] }
```

Referentially transparent. No closures, no IO, no mutation. Fully exhaustive over the 12 `AgentHookEvent` variants × 3 phases × `existingTask` presence. Each transition emits its effects in the order today's procedural code calls them — preserving observable behaviour for the existing 100 tests.

### 2. Effect applier — `electron/hook-relay-effects.ts`

```ts
function applyEffects(effects: Effect[], deps: HookRelayDeps): void
```

Walks the effect list and calls `taskManager.*`, `relayAgentHook`, `broadcastTask`, `maybeSendNotification`, plus inline mutates `unseenRespondedTasks` / `unseenInputTasks`. One small switch per effect kind; ~150 lines.

### 3. Factory wiring — `electron/hook-relay.ts`

`relay()` shrinks to ~25 lines:

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

  applyEffects(result.effects, deps);
}
```

`paneRootSessionMap` mutations move into effects (`SetPaneRoot` / `DeletePaneRoot`) handled by the applier.

### Out of scope

- **`sweepStaleSessions`** stays as today — it's timer-driven, walks `sessionStateMap`, mutates state directly, calls `applyStopForSession`. The state machine handles the hot path (hook events); sweeps are out-of-band recovery. Migrating sweeps to also flow through the transition function is a follow-up — likely a future ADR if/when a new sweep branch shows up.
- **`notifyAgentDetectorGone`** stays as today — it's the kill-9 bridge from the AgentDetector, not a hook event. Same reasoning.
- **`applyStopForSession`** stays as a callable helper because sweeps and the bridge both invoke it. Internally it's now also reached via the transition function's `ApplyStop` effect.
- The new `SessionPhase` is in-process only. No persistence, no IPC.

## Consequences

**Better:**
- Every relay invariant is a row in the transition table. Today's "responded → not re-active" fix becomes one cell (`active × Stop → responded`, then `responded × <non-UserPromptSubmit-active> → no-op`), not an inline guard.
- Tests split into transition-table tests (pure, fast, ~12 events × 3 phases × task-present/absent ≈ 60 cases) and integration tests (existing 100, unchanged behaviour).
- Future safety-net ADRs add a transition row, not a new `if`-block in a procedural function.
- Effect ordering is explicit — the side-effect sequence is a function output, not an inline call sequence buried in a 250-line if-tree.

**Tradeoffs:**
- Two new files (~400 LOC transition, ~150 LOC applier). More file-level navigation; pays off when reading a single state-event pair.
- Two layers where there was one. The applier doesn't add logic — it just walks the effect list — but it is one more hop to read.

**Risks:**
- **Effect ordering is load-bearing.** The existing 100 tests assert specific call orders (`maybeSendNotification` vs `broadcastTask` timing, `unseenInputTasks` mutation timing). The transition function must emit effects in today's exact order. Mitigation: integration tests catch any drift; transition tests pin the effect list explicitly per case.
- **Escape-hatch tension.** Sweeps and `notifyAgentDetectorGone` continue to mutate state directly. If a future sweep change re-introduces complex inline logic outside the FSM, the abstraction's value erodes. Mitigation: documented as out-of-scope here; sweeps in-scope for a future ADR if their complexity grows.
- **Regression risk** during ticket 2 (rewiring). Mitigation: existing test suite is the safety net; ticket sequence runs sequentially with verification between tickets.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
