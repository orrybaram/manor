/**
 * Pure transition function for the hook relay state machine.
 *
 * See ADR-139. This module is intentionally side-effect free:
 *  - no IO, no closures, no IPC, no logging
 *  - inputs (`state`, `event`, `context`) are not mutated
 *  - the `activeSubagents` Set is cloned whenever it changes
 *
 * The output is `{ state, effects }`:
 *  - `state` is the new SessionState (or `null` to delete the entry)
 *  - `effects` is an ordered list the applier walks to perform the actual
 *    side effects (relayAgentHook, taskManager.*, broadcastTask, etc.)
 *
 * Behaviour parity with `electron/hook-relay.ts`'s `relay()` is load-bearing:
 * the existing integration tests pin specific call orders. Effect ordering
 * here mirrors today's procedural sequence exactly.
 */

import type { AgentHookEvent } from "./agent-hook-events";
import type { AgentStatus, AgentKind } from "./terminal-host/types";
import type { TaskInfo } from "./task-persistence";

// ── Public types ──

export type SessionPhase = "active" | "pendingStop" | "responded";

export interface SessionState {
  phase: SessionPhase;
  activeSubagents: Set<string>;
  /** Monotonic ms — see ADR-135 ticket-4. */
  lastHookEventAt: number;
}

export type Effect =
  | {
      kind: "RelayAgentHook";
      paneId: string;
      status: AgentStatus;
      agentKind: AgentKind;
    }
  | { kind: "SetPaneRoot"; paneId: string; sessionId: string }
  | { kind: "DeletePaneRoot"; paneId: string }
  | { kind: "ForceCloseOldSession"; sessionId: string }
  | { kind: "DeleteSessionState"; sessionId: string }
  | {
      kind: "CreateTask";
      sessionId: string;
      paneId: string;
      agentKind: AgentKind;
      status: AgentStatus;
    }
  | {
      kind: "UpdateTaskActiveStatus";
      sessionId: string;
      status: AgentStatus;
    }
  | { kind: "ApplyStop"; sessionId: string }
  | { kind: "MarkCompleted"; sessionId: string }
  | { kind: "MarkError"; sessionId: string };

export interface TransitionContext {
  /** Current root session for the event's pane, or null. */
  paneRootSession: string | null;
  /** Existing task for the event's sessionId, or null. */
  existingTask: TaskInfo | null;
  /** Monotonic ms — used to stamp `lastHookEventAt` on the new state. */
  nowMs: number;
}

export interface TransitionResult {
  state: SessionState | null;
  effects: Effect[];
}

// ── Local constants (mirrored from hook-relay.ts) ──

const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "thinking",
  "working",
  "requires_input",
]);

// ── Helpers ──

/** Build a fresh "active" state, stamping lastHookEventAt with nowMs. */
function freshActiveState(nowMs: number): SessionState {
  return {
    phase: "active",
    activeSubagents: new Set<string>(),
    lastHookEventAt: nowMs,
  };
}

/** Clone a state, optionally overriding fields. The Set is cloned. */
function cloneState(
  state: SessionState,
  overrides: Partial<SessionState> = {},
): SessionState {
  return {
    phase: overrides.phase ?? state.phase,
    activeSubagents:
      overrides.activeSubagents ?? new Set(state.activeSubagents),
    lastHookEventAt: overrides.lastHookEventAt ?? state.lastHookEventAt,
  };
}

// ── Main transition ──

export function transitionSession(
  state: SessionState | null,
  event: AgentHookEvent,
  context: TransitionContext,
): TransitionResult {
  const { paneId, sessionId, agentKind, status, type: eventType } = event;
  const { paneRootSession, existingTask, nowMs } = context;

  // ── 1. Late-active guard ──
  // Drop late active-status events for an already-responded session. Hook
  // delivery is independent HTTP, so PostToolUse / PreToolUse can race in
  // after Stop and would otherwise re-flip the task and AgentDetector dot.
  // Only UserPromptSubmit legitimately re-activates a responded session
  // (next turn). SessionStart/SessionEnd are lifecycle events handled below.
  if (
    sessionId &&
    ACTIVE_STATUSES.has(status) &&
    eventType !== "UserPromptSubmit" &&
    eventType !== "SessionStart" &&
    existingTask?.lastAgentStatus === "responded"
  ) {
    return { state, effects: [] };
  }

  // ── 2. SessionStart ──
  // Never relays to AgentDetector (per ADR-014: agent stays idle until a
  // real event). Maintains paneRootSessionMap; resets old root if any.
  if (eventType === "SessionStart") {
    const effects: Effect[] = [];

    if (sessionId) {
      if (paneRootSession && paneRootSession !== sessionId) {
        effects.push({ kind: "ForceCloseOldSession", sessionId: paneRootSession });
        effects.push({ kind: "DeletePaneRoot", paneId });
        effects.push({ kind: "DeleteSessionState", sessionId: paneRootSession });
      }
      effects.push({ kind: "SetPaneRoot", paneId, sessionId });
    }

    // Returning `state: null` here means "no session-state change for the
    // event's sessionId". The relay's outer wiring uses this only to write
    // a fresh map entry on first non-SessionStart event.
    return { state: null, effects };
  }

  // ── 3. RelayAgentHook for everything except SessionStart ──
  // We accumulate effects for the rest of the function so we can short-circuit
  // cleanly. Order matters: RelayAgentHook is the first effect for non-
  // SessionStart events, and stays first whether or not we proceed to task
  // persistence below.
  const effects: Effect[] = [
    { kind: "RelayAgentHook", paneId, status, agentKind },
  ];

  // ── 4. No sessionId — relay only, no task persistence ──
  if (!sessionId) {
    return { state, effects };
  }

  // ── 5. Subagent-session detection ──
  // If a root already exists for this pane and the event's sessionId differs,
  // it's a subagent session — relay only, no task state mutations.
  if (paneRootSession !== null && paneRootSession !== sessionId) {
    return { state, effects };
  }

  // If no root for this pane yet, claim it. Mirrors today's procedural code
  // at hook-relay.ts:287 (`paneRootSessionMap.set(paneId, sessionId)`).
  if (paneRootSession === null) {
    effects.push({ kind: "SetPaneRoot", paneId, sessionId });
  }

  // ── 6. Update lastHookEventAt; lazily create state ──
  // From here we know the event belongs to the pane's root session.
  let nextState: SessionState =
    state !== null
      ? cloneState(state, { lastHookEventAt: nowMs })
      : freshActiveState(nowMs);

  // Track whether we *had* a real prior state. When state was null we may
  // need to drop terminal events below (the hasBeenActive guard).
  const hadPriorState = state !== null;

  // ── 7. SubagentStart / SubagentStop set updates ──
  // Both events also have active statuses ("working", "thinking"), so they
  // fall through into the active-status branch below and create/update a task.
  if (eventType === "SubagentStart") {
    const next = new Set(nextState.activeSubagents);
    const id = event.toolUseId ?? `__fallback_${next.size}`;
    next.add(id);
    nextState = { ...nextState, activeSubagents: next };
  } else if (eventType === "SubagentStop") {
    const next = new Set(nextState.activeSubagents);
    if (event.toolUseId) {
      next.delete(event.toolUseId);
    } else {
      const first = next.values().next().value;
      if (first !== undefined) next.delete(first);
    }
    nextState = { ...nextState, activeSubagents: next };
  }

  // ── 8. Active-status events: create or update task ──
  if (ACTIVE_STATUSES.has(status)) {
    // Reaching an active event marks the session active. If we were in
    // "responded" already, the late-active guard at step 1 would have
    // returned for everything except UserPromptSubmit (and SessionStart,
    // handled separately). UserPromptSubmit is a legitimate next turn —
    // flip back to active.
    nextState = { ...nextState, phase: "active" };

    if (existingTask) {
      effects.push({
        kind: "UpdateTaskActiveStatus",
        sessionId,
        status,
      });
    } else {
      effects.push({
        kind: "CreateTask",
        sessionId,
        paneId,
        agentKind,
        status,
      });
    }

    return { state: nextState, effects };
  }

  // ── 9. Terminal / completion statuses ──
  // (status is one of "idle" | "complete" | "error" | "responded", and the
  //  event must be Stop / SessionEnd / StopFailure given the typed union.)

  // hasBeenActive guard — if we've never seen an active event for this
  // session, drop the terminal event entirely. In the new model that means
  // `state === null` on entry (no prior state was created).
  if (!hadPriorState) {
    return { state: null, effects: [] };
  }

  if (eventType === "Stop") {
    if (nextState.activeSubagents.size > 0) {
      // Hold the Stop until the subagents finish; the sweep or a later
      // SessionEnd will apply it.
      nextState = { ...nextState, phase: "pendingStop" };
      return { state: nextState, effects };
    }
    effects.push({ kind: "ApplyStop", sessionId });
    nextState = { ...nextState, phase: "responded" };
    return { state: nextState, effects };
  }

  if (eventType === "SessionEnd") {
    // If a Stop was held pending, drain it first so MarkCompleted sees the
    // task in the responded state. Mirrors hook-relay.ts:380-387.
    if (nextState.phase === "pendingStop") {
      effects.push({ kind: "ApplyStop", sessionId });
    }
    effects.push({ kind: "MarkCompleted", sessionId });
    effects.push({ kind: "DeletePaneRoot", paneId });
    return { state: null, effects };
  }

  if (eventType === "StopFailure") {
    effects.push({ kind: "MarkError", sessionId });
    // Note: original code (hook-relay.ts:415) deletes only sessionStateMap
    // here, not paneRootSessionMap. Preserved.
    return { state: null, effects };
  }

  // Defensive fall-through: only reachable if a future AgentHookEvent variant
  // is added without an explicit branch above. We keep `nextState` (with the
  // refreshed lastHookEventAt) and the already-emitted RelayAgentHook so the
  // detector still gets the event.
  return { state: nextState, effects };
}
