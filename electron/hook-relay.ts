/**
 * Hook relay factory — extracted from app-lifecycle.ts for testability.
 *
 * `createHookRelay(deps)` returns the relay callback that AgentHookServer.setRelay() expects.
 * The caller (app-lifecycle) wires up the real deps; tests inject fakes.
 */

import type { AgentStatus, AgentKind } from "./terminal-host/types";
import type { TaskInfo } from "./task-persistence";

// ── Types ──

export interface SessionState {
  activeSubagents: Set<string>;
  hasBeenActive: boolean;
  pendingStopAt: number | null;
  lastHookEventAt: number;
}

/** Structural interface for the task persistence layer (allows fakes in tests). */
export interface ITaskManager {
  createTask(data: Omit<TaskInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">): TaskInfo;
  updateTask(id: string, updates: Partial<TaskInfo>): TaskInfo | null;
  getTaskBySessionId(sessionId: string): TaskInfo | null;
  getTaskByPaneId(paneId: string): TaskInfo | null;
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

// ── Factory ──

export interface HookRelayContext {
  relay: RelayFn;
  sessionStateMap: Map<string, SessionState>;
  paneRootSessionMap: Map<string, string>;
  /** Apply a pending Stop for the given session (exported for sweep use) */
  applyStopForSession: (sessionId: string) => void;
  sweepStaleSessions: () => void;
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
  } = deps;

  const sessionStateMap = new Map<string, SessionState>();
  const paneRootSessionMap = new Map<string, string>();

  function getOrCreateSessionState(sessionId: string): SessionState {
    let state = sessionStateMap.get(sessionId);
    if (!state) {
      state = {
        activeSubagents: new Set(),
        hasBeenActive: false,
        pendingStopAt: null,
        lastHookEventAt: Date.now(),
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
    relayAgentHook(paneId, status, kind);

    if (!sessionId) {
      console.debug(
        `[task-lifecycle] No sessionId for ${eventType} on pane ${paneId} — skipping task persistence`,
      );
      return;
    }

    if (eventType === "SessionStart") {
      const oldRoot = paneRootSessionMap.get(paneId);
      if (oldRoot && oldRoot !== sessionId) {
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
    sessionState.lastHookEventAt = Date.now();

    if (ACTIVE_STATUSES.has(status)) {
      sessionState.hasBeenActive = true;

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
        sessionState.pendingStopAt = Date.now();
        return;
      }
      sessionState.pendingStopAt = null;
      applyStopForSession(sessionId);
    } else if (eventType === "SessionEnd") {
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
    const now = Date.now();
    for (const [sessionId, state] of sessionStateMap) {
      const idle = now - state.lastHookEventAt;

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
        if (
          task &&
          (task.lastAgentStatus === "thinking" ||
            task.lastAgentStatus === "working")
        ) {
          console.debug(
            `[task-lifecycle] stale-active sweep: forcing responded on ${sessionId} ` +
              `(lastAgentStatus=${task.lastAgentStatus}, idle=${idle}ms)`,
          );
          state.activeSubagents.clear();
          applyStopForSession(sessionId);
        }
      }
    }
  }

  return { relay, sessionStateMap, paneRootSessionMap, applyStopForSession, sweepStaleSessions };
}
