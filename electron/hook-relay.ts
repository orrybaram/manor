/**
 * Hook relay factory — extracted from app-lifecycle.ts for testability.
 *
 * `createHookRelay(deps)` returns the relay callback that AgentHookServer.setRelay() expects.
 * The caller (app-lifecycle) wires up the real deps; tests inject fakes.
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
 */

import type { AgentStatus, AgentKind } from "./terminal-host/types";
import type { TaskInfo } from "./task-persistence";

// ── Types ──

export interface SessionState {
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

export type RelayFn = (
  paneId: string,
  status: AgentStatus,
  kind: AgentKind,
  sessionId: string | null,
  eventType: string,
  toolUseId: string | null,
) => void;

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

  function getOrCreateSessionState(sessionId: string): SessionState {
    let state = sessionStateMap.get(sessionId);
    if (!state) {
      state = {
        activeSubagents: new Set(),
        hasBeenActive: false,
        pendingStopAt: null,
        lastHookEventAt: nowMonoMs(),
      };
      sessionStateMap.set(sessionId, state);
    }
    return state;
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

  function relay(
    paneId: string,
    status: AgentStatus,
    kind: AgentKind,
    sessionId: string | null,
    eventType: string,
    toolUseId: string | null,
  ): void {
    // SessionStart fires when the agent CLI launches — before any user
    // activity. Per ADR-014, the agent should remain idle until a real event
    // (UserPromptSubmit, PreToolUse, etc.) arrives. Skip the AgentDetector
    // flip so the spinner doesn't appear on bare process startup. The relay
    // still processes SessionStart below to maintain paneRootSessionMap.
    if (eventType !== "SessionStart") {
      relayAgentHook(paneId, status, kind);
    }

    if (!sessionId) {
      console.debug(
        `[task-lifecycle] No sessionId for ${eventType} on pane ${paneId} — skipping task persistence`,
      );
      return;
    }

    if (eventType === "SessionStart") {
      const oldRoot = paneRootSessionMap.get(paneId);
      if (oldRoot && oldRoot !== sessionId) {
        const oldState = sessionStateMap.get(oldRoot);
        const oldTask = taskManager.getTaskBySessionId(oldRoot);
        if (
          oldTask &&
          oldState?.hasBeenActive &&
          isStuckActive(oldTask.lastAgentStatus)
        ) {
          console.debug(
            `[task-lifecycle] SessionStart replacement: forcing responded on old session ${oldRoot}`,
          );
          if (oldState) {
            oldState.activeSubagents.clear();
            oldState.pendingStopAt = null;
          }
          applyStopForSession(oldRoot);
        }
        console.debug(
          `[task-lifecycle] SessionStart: resetting root session on pane ${paneId} (${oldRoot} → ${sessionId})`,
        );
        paneRootSessionMap.delete(paneId);
        sessionStateMap.delete(oldRoot);
      }
      paneRootSessionMap.set(paneId, sessionId);
      return;
    }

    const rootSession = paneRootSessionMap.get(paneId);
    if (!rootSession) {
      paneRootSessionMap.set(paneId, sessionId);
    } else if (rootSession !== sessionId) {
      console.debug(
        `[task-lifecycle] Subagent session ${sessionId} on pane ${paneId} (root=${rootSession}) — skipping task persistence`,
      );
      return;
    }

    const sessionState = getOrCreateSessionState(sessionId);
    sessionState.lastHookEventAt = nowMonoMs();

    if (eventType === "SubagentStart") {
      const id = toolUseId ?? `__fallback_${sessionState.activeSubagents.size}`;
      sessionState.activeSubagents.add(id);
    } else if (eventType === "SubagentStop") {
      if (toolUseId) {
        sessionState.activeSubagents.delete(toolUseId);
      } else {
        const first = sessionState.activeSubagents.values().next().value;
        if (first !== undefined) sessionState.activeSubagents.delete(first);
      }
    }

    if (ACTIVE_STATUSES.has(status)) {
      sessionState.hasBeenActive = true;

      let task = taskManager.getTaskBySessionId(sessionId);
      const now = new Date().toISOString();

      if (!task) {
        const prevPaneTask = taskManager.getTaskByPaneId(paneId);
        if (prevPaneTask) {
          taskManager.updateTask(prevPaneTask.id, { paneId: null });
        }

        const paneContext = getPaneContext(paneId);
        task = taskManager.createTask({
          agentSessionId: sessionId,
          name: null,
          status: "active",
          completedAt: null,
          projectId: paneContext?.projectId ?? null,
          projectName: paneContext?.projectName ?? null,
          workspacePath: paneContext?.workspacePath ?? null,
          cwd: paneContext?.workspacePath ?? "",
          agentKind: kind,
          agentCommand: paneContext?.agentCommand ?? null,
          paneId,
          lastAgentStatus: status,
          resumedAt: null,
        });
        task = taskManager.updateTask(task.id, { activatedAt: now });
        if (task && status === "requires_input") {
          unseenInputTasks.add(task.id);
        }
      } else {
        const prevStatus = task.lastAgentStatus;
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: status,
          status: "active",
          ...(task.activatedAt ? {} : { activatedAt: now }),
        });
        if (task) {
          if (status === "requires_input") {
            unseenInputTasks.add(task.id);
          }
          maybeSendNotification(task, prevStatus, status);
        }
      }

      if (task) broadcastTask(task);
      return;
    }

    // Terminal / completion statuses

    if (!sessionState.hasBeenActive) {
      console.debug(
        `[task-lifecycle] Skipping ${status} for session ${sessionId} — never activated`,
      );
      return;
    }

    let task = taskManager.getTaskBySessionId(sessionId);

    if (eventType === "Stop") {
      if (sessionState.activeSubagents.size > 0) {
        sessionState.pendingStopAt = nowMonoMs();
        return;
      }
      sessionState.pendingStopAt = null;
      applyStopForSession(sessionId);
    } else if (eventType === "SessionEnd") {
      if (sessionState.pendingStopAt !== null) {
        sessionState.activeSubagents.clear();
        sessionState.pendingStopAt = null;
        applyStopForSession(sessionId);
        // applyStopForSession mutated the task; re-fetch so the completed transition
        // sees the updated lastAgentStatus.
        task = taskManager.getTaskBySessionId(sessionId);
      }
      if (task) {
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: "complete",
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        if (task) {
          unseenRespondedTasks.delete(task.id);
          unseenInputTasks.delete(task.id);
          broadcastTask(task);
        }
      }
      sessionStateMap.delete(sessionId);
      paneRootSessionMap.delete(paneId);
    } else if (eventType === "StopFailure") {
      if (task) {
        task = taskManager.updateTask(task.id, {
          lastAgentStatus: status,
          status: "error",
          completedAt: new Date().toISOString(),
        });
        if (task) {
          unseenRespondedTasks.delete(task.id);
          unseenInputTasks.delete(task.id);
          broadcastTask(task);
        }
      }
      sessionStateMap.delete(sessionId);
    }
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
