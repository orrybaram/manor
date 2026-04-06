import { useAppStore } from "../store/app-store";
import { cleanAgentTitle } from "../utils/agent-title";
import type { AgentState, AgentStatus, TaskInfo, TaskStatus } from "../electron.d";

/**
 * Strip SSH-style CWD titles (e.g. "user@host:/path") and clean agent
 * spinner/marker characters. Returns null when the raw title is empty
 * or represents a CWD rather than a task description.
 */
export function cleanLiveTitle(raw: string | null): string | null {
  if (!raw) return null;
  // SSH-style CWD titles like "user@host:/some/path" are not task descriptions
  if (/.+@.+:.+/.test(raw)) return null;
  return cleanAgentTitle(raw);
}

/**
 * Derive a single AgentStatus for a task by preferring live pane data,
 * then the persisted lastAgentStatus, then a static mapping from TaskStatus.
 */
export function deriveStatus(
  task: TaskInfo,
  liveAgent: AgentState | null,
): AgentStatus | undefined {
  // Live agent with a meaningful (non-idle) status takes priority
  if (
    task.status === "active" &&
    liveAgent &&
    liveAgent.status !== "idle"
  ) {
    return liveAgent.status;
  }

  // Persisted agent status from the last known snapshot
  if (task.status === "active" && task.lastAgentStatus) {
    return task.lastAgentStatus as AgentStatus;
  }

  // Static fallback based on task lifecycle status
  const statusMap: Record<TaskStatus, AgentStatus> = {
    active: "working",
    completed: "complete",
    error: "error",
    abandoned: "idle",
  };
  return statusMap[task.status];
}

/**
 * Unified hook that derives display title and agent status for a task,
 * preferring live pane data when the task has an active terminal pane.
 */
export function useTaskDisplay(
  task: TaskInfo,
): { title: string; status: AgentStatus | undefined } {
  const liveAgent = useAppStore((s) =>
    task.paneId ? s.paneAgentStatus[task.paneId] ?? null : null,
  );
  const liveTitle = useAppStore((s) =>
    task.paneId ? s.paneTitle[task.paneId] ?? null : null,
  );

  const title = cleanLiveTitle(liveTitle) ?? task.name ?? "Agent";
  const status = deriveStatus(task, liveAgent);

  return { title, status };
}
