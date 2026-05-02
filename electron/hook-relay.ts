/**
 * Hook relay factory — extracted from app-lifecycle.ts for testability.
 *
 * `createHookRelay(deps)` returns the relay callback that AgentHookServer.setRelay() expects.
 * The caller (app-lifecycle) wires up the real deps; tests inject fakes.
 *
 * Transition logic lives in `hook-relay-transition.ts`; effect application
 * in `hook-relay-effects.ts`. The factory below wires them to the
 * persistent state (sessionStateMap, paneRootSessionMap) and the deps.
 */

/**
 * Identifier namespaces inside the relay
 *
 * - `paneId`     — the daemon's session id (== paneId on the renderer side).
 *                 Lifetime: created on `pty:create`, destroyed on `pty:close`.
 * - `sessionId`  — the agent CLI's session UUID, extracted from hook payloads.
 *                 Lifetime: created on `SessionStart`, destroyed on `SessionEnd`.
 *                 One pane can host multiple sessions over its lifetime
 *                 (`/clear`, `claude --resume`).
 *
 * Two maps:
 * - paneRootSessionMap: Map<paneId, sessionId>
 *     The current root session on each pane. Used to ignore subagent
 *     SessionStart events and to resolve the pane's *current* task when a hook
 *     event arrives without enough context.
 * - sessionStateMap: Map<sessionId, SessionState>
 *     Per-agent-session bookkeeping (active subagents, pendingStopAt, etc).
 *     Cleared on SessionEnd, on SessionStart replacement, and by stale-orphan
 *     sweeps.
 *
 * Always carry the namespace explicitly: the bug fixed by ADR-133 was a sweep
 * comparing a sessionId against a paneId set.
 *
 * Lifecycle invariants
 *
 * - A session that has reached `responded` (via `Stop`) must not be flipped
 *   back into an active status by any subsequent hook event other than
 *   `UserPromptSubmit` (legitimate next turn) or the lifecycle events
 *   `SessionStart` / `SessionEnd`. Hook delivery is independent HTTP, so a
 *   tool's `PostToolUse` can race in after `Stop` — without this guard the
 *   late event re-activates the task and the AgentDetector dot.
 *   Enforced by the transition function's late-active guard.
 */

import type { AgentStatus, AgentKind } from "./terminal-host/types";
import type { TaskInfo } from "./task-persistence";
import type { AgentHookEvent } from "./agent-hook-events";
import {
  transitionSession,
  type SessionState as TransitionSessionState,
  type SessionPhase,
} from "./hook-relay-transition";
import { applyEffects } from "./hook-relay-effects";

// ── Types ──

/**
 * Persisted session state, stored in `sessionStateMap`.
 *
 * Includes both the new ADR-139 transition fields (`phase`,
 * `activeSubagents`, `lastHookEventAt`) and the legacy bookkeeping fields
 * (`pendingStopAt`, `hasBeenActive`) that sweeps and the AgentDetector
 * bridge still consume directly. The legacy fields are kept in sync with
 * `phase` by the relay() wiring after each transition.
 */
export interface SessionState {
  phase: SessionPhase;
  activeSubagents: Set<string>;
  hasBeenActive: boolean;
  /** Monotonic ms (process.hrtime.bigint() / 1e6) — see ADR-135 ticket-4. */
  pendingStopAt: number | null;
  /** Monotonic ms (process.hrtime.bigint() / 1e6) — see ADR-135 ticket-4. */
  lastHookEventAt: number;
}

/** Default monotonic clock — wraps process.hrtime.bigint() to ms. */
export function defaultMonoClock(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Default wall clock — wraps Date.now(). */
export function defaultWallClock(): number {
  return Date.now();
}

/** Structural interface for the task persistence layer (allows fakes in tests). */
export interface ITaskManager {
  createTask(data: Omit<TaskInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">): TaskInfo;
  updateTask(id: string, updates: Partial<TaskInfo>): TaskInfo | null;
  getTaskBySessionId(sessionId: string): TaskInfo | null;
  getTaskByPaneId(paneId: string): TaskInfo | null;
  getActiveTasks(): TaskInfo[];
}

export interface HookRelayDeps {
  /** Relay the hook event to the daemon's AgentDetector state machine */
  relayAgentHook: (paneId: string, status: AgentStatus, kind: AgentKind) => void;
  taskManager: ITaskManager;
  /** Returns the current pane context (projectId, projectName, workspacePath, agentCommand) */
  getPaneContext: (paneId: string) => {
    projectId: string;
    projectName: string;
    workspacePath: string;
    agentCommand: string | null;
  } | undefined;
  unseenRespondedTasks: Set<string>;
  unseenInputTasks: Set<string>;
  /** Broadcast a task-updated event to the renderer and update the dock badge */
  broadcastTask: (task: TaskInfo) => void;
  /** Send an OS notification if needed */
  maybeSendNotification: (
    task: TaskInfo,
    prevStatus: string | null | undefined,
    newStatus: AgentStatus,
  ) => void;
  /** Optional monotonic clock injection for tests. Defaults to process.hrtime.bigint() / 1e6. */
  monoClock?: () => number;
  /** Optional wall clock injection for tests. Defaults to Date.now(). */
  wallClock?: () => number;
}

export type RelayFn = (event: AgentHookEvent) => void;

// ── Constants (exported for tests) ──

export const STALE_STOP_MS = 15_000;
export const STALE_ACTIVE_MS = 60_000;
export const SWEEP_INTERVAL_MS = 10_000;

const ACTIVE_STATUSES: Set<AgentStatus> = new Set([
  "thinking",
  "working",
  "requires_input",
]);

/** Statuses that indicate the task is "stuck active" and should be recovered by sweeps / replacement. */
const STUCK_ACTIVE: ReadonlySet<string> = new Set(["thinking", "working", "requires_input"]);
function isStuckActive(status: string | null | undefined): boolean {
  return status != null && STUCK_ACTIVE.has(status);
}

// ── Factory ──

export interface HookRelayContext {
  relay: RelayFn;
  sessionStateMap: Map<string, SessionState>;
  paneRootSessionMap: Map<string, string>;
  /** Apply a pending Stop for the given session (exported for sweep use) */
  applyStopForSession: (sessionId: string) => void;
  sweepStaleSessions: () => void;
  notifyAgentDetectorGone: (paneId: string) => void;
}

export function createHookRelay(deps: HookRelayDeps): HookRelayContext {
  const {
    relayAgentHook,
    taskManager,
    getPaneContext,
    unseenRespondedTasks,
    unseenInputTasks,
    broadcastTask,
    maybeSendNotification,
    monoClock = defaultMonoClock,
    wallClock = defaultWallClock,
  } = deps;

  // Per-relay boot timestamps — captured in the factory closure (NOT module scope).
  // Used by taskMonotonicAgeMs() to clamp wall-clock task ages by the relay's
  // actual monotonic run-time, defeating wall-clock jumps from suspend/resume.
  const RELAY_BOOT_MONO_MS = monoClock();
  const RELAY_BOOT_WALL_MS = wallClock();

  function nowMonoMs(): number {
    return monoClock();
  }

  /**
   * Compute a task's age in milliseconds, clamped by the relay's monotonic run-time.
   *
   * `task.activatedAt` is a wall-clock ISO string (kept for display + cross-restart
   * durability). After a laptop suspend/resume the wall clock jumps forward but the
   * relay's monotonic clock does not, so wall-only math would force-complete every
   * mid-session task on first wake. Clamping by the monotonic time the relay has
   * been running ensures we wait the full STALE_ACTIVE_MS of *real* run-time.
   */
  function taskMonotonicAgeMs(task: TaskInfo): number {
    if (!task.activatedAt) return 0;
    const wallAge = wallClock() - Date.parse(task.activatedAt);
    if (Number.isNaN(wallAge) || wallAge < 0) return 0;
    const monoSinceBoot = nowMonoMs() - RELAY_BOOT_MONO_MS;
    const wallSinceBoot = wallClock() - RELAY_BOOT_WALL_MS;
    if (wallSinceBoot > monoSinceBoot) {
      return Math.min(wallAge, monoSinceBoot);
    }
    return wallAge;
  }

  const sessionStateMap = new Map<string, SessionState>();
  const paneRootSessionMap = new Map<string, string>();

  /**
   * Reconcile the new transition state (phase, activeSubagents,
   * lastHookEventAt) with the persisted bookkeeping fields (pendingStopAt,
   * hasBeenActive) that sweeps and the AgentDetector bridge consume.
   *
   * Rules:
   *  - hasBeenActive: any persisted state has been active (the transition
   *    function only persists state for sessions that have reached step 6
   *    of transitionSession; terminal events on never-active sessions
   *    return state: null and do not persist).
   *  - pendingStopAt:
   *    - phase === "pendingStop": preserve the existing pendingStopAt if set
   *      (the moment Stop originally arrived), otherwise stamp with
   *      lastHookEventAt — this is the moment we entered pendingStop.
   *    - phase === "responded": cleared (Stop has been applied).
   *    - phase === "active": preserved unchanged. Mirrors the pre-ADR-139
   *      behaviour where active hook events did not clear pendingStopAt; a
   *      held Stop continued to wait until the subagents finished or a
   *      sweep / SessionEnd drained it.
   */
  function reconcilePersistedState(
    next: TransitionSessionState | null,
    prev: SessionState | null,
  ): SessionState | null {
    if (next === null) return null;
    let pendingStopAt: number | null;
    if (next.phase === "pendingStop") {
      pendingStopAt = prev?.pendingStopAt ?? next.lastHookEventAt;
    } else if (next.phase === "responded") {
      pendingStopAt = null;
    } else {
      // active — preserve any in-flight pending Stop from a prior turn.
      pendingStopAt = prev?.pendingStopAt ?? null;
    }
    // Mutate prev in place when present, so external captures of the state
    // object (sweeps, tests, the bridge) keep observing the live state.
    if (prev) {
      prev.phase = next.phase;
      prev.activeSubagents = next.activeSubagents;
      prev.hasBeenActive = true;
      prev.pendingStopAt = pendingStopAt;
      prev.lastHookEventAt = next.lastHookEventAt;
      return prev;
    }
    return {
      phase: next.phase,
      activeSubagents: next.activeSubagents,
      hasBeenActive: true,
      pendingStopAt,
      lastHookEventAt: next.lastHookEventAt,
    };
  }

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

  function relay(event: AgentHookEvent): void {
    const sessionId = event.sessionId;
    const prevState: SessionState | null = sessionId
      ? sessionStateMap.get(sessionId) ?? null
      : null;
    const existingTask = sessionId
      ? taskManager.getTaskBySessionId(sessionId)
      : null;

    const result = transitionSession(prevState, event, {
      paneRootSession: paneRootSessionMap.get(event.paneId) ?? null,
      existingTask,
      nowMs: nowMonoMs(),
    });

    // Persist new state for this sessionId, reconciling legacy bookkeeping
    // fields (pendingStopAt, hasBeenActive) with the transition's phase.
    if (sessionId) {
      const reconciled = reconcilePersistedState(result.state, prevState);
      if (reconciled) sessionStateMap.set(sessionId, reconciled);
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
      sessionStateMap,
      applyStopForSession,
    });
  }

  function sweepStaleSessions(): void {
    const nowMono = nowMonoMs();
    for (const [sessionId, state] of sessionStateMap) {
      // Idle is monotonic — wall-clock jumps from suspend/resume can't push us
      // past the threshold artificially.
      const idle = nowMono - state.lastHookEventAt;

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
        if (task && isStuckActive(task.lastAgentStatus)) {
          console.debug(
            `[task-lifecycle] stale-active sweep: forcing responded on ${sessionId} ` +
              `(lastAgentStatus=${task.lastAgentStatus}, idle=${idle}ms)`,
          );
          state.activeSubagents.clear();
          applyStopForSession(sessionId);
        }
      }
    }

    // Branch 3 (ADR-132): task is active but its session state is gone.
    // Catches orphans from SessionStart replacement, SessionEnd races, and
    // main-process restarts that rehydrate tasks without their sessionState.
    // Uses taskMonotonicAgeMs() to clamp the wall-clock activatedAt by the
    // relay's monotonic run-time so suspend/resume can't trip the threshold.
    const ORPHAN_TASK_MS = STALE_ACTIVE_MS; // share the 60s threshold
    for (const task of taskManager.getActiveTasks()) {
      if (!task.agentSessionId) continue;
      if (sessionStateMap.has(task.agentSessionId)) continue;
      if (!isStuckActive(task.lastAgentStatus)) continue;

      const age = taskMonotonicAgeMs(task);
      if (age < ORPHAN_TASK_MS) continue;

      console.debug(
        `[task-lifecycle] orphan-task sweep: forcing responded on ${task.agentSessionId} ` +
          `(task.id=${task.id}, lastAgentStatus=${task.lastAgentStatus}, age=${age}ms)`,
      );
      applyStopForSession(task.agentSessionId);
    }
  }

  function notifyAgentDetectorGone(paneId: string): void {
    const rootSession = paneRootSessionMap.get(paneId);
    if (!rootSession) return;
    const task = taskManager.getTaskBySessionId(rootSession);
    if (!task) return;
    if (!isStuckActive(task.lastAgentStatus)) {
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

  return { relay, sessionStateMap, paneRootSessionMap, applyStopForSession, sweepStaleSessions, notifyAgentDetectorGone };
}
