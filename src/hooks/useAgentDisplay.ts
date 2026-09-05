import { useAppStore } from "../store/app-store";
import { cleanAgentTitle } from "../utils/agent-title";
import type { AgentState, AgentStatus, AgentInfo, AgentLifecycleStatus } from "../electron.d";

/**
 * Strip SSH-style CWD titles (e.g. "user@host:/path") and clean agent
 * spinner/marker characters. Returns null when the raw title is empty
 * or represents a CWD rather than an agent description.
 */
export function cleanLiveTitle(raw: string | null): string | null {
  if (!raw) return null;
  // SSH-style CWD titles like "user@host:/some/path" are not agent descriptions
  if (/.+@.+:.+/.test(raw)) return null;
  return cleanAgentTitle(raw);
}

/**
 * Derive a single AgentStatus for an agent by preferring live pane data,
 * then the persisted lastAgentStatus, then a static mapping from AgentLifecycleStatus.
 */
export function deriveStatus(
  agent: AgentInfo,
  liveAgent: AgentState | null,
): AgentStatus | undefined {
  // Live agent with a meaningful (non-idle) status takes priority
  if (
    agent.status === "active" &&
    liveAgent &&
    liveAgent.status !== "idle"
  ) {
    return liveAgent.status;
  }

  // Persisted agent status from the last known snapshot
  if (agent.status === "active" && agent.lastAgentStatus) {
    return agent.lastAgentStatus as AgentStatus;
  }

  // For non-active agents that have a known last status, prefer it over the static map
  // (e.g. a "responded" agent that got incorrectly abandoned should still show the dot)
  if (agent.lastAgentStatus) {
    return agent.lastAgentStatus as AgentStatus;
  }

  // Static fallback based on agent lifecycle status
  const statusMap: Record<AgentLifecycleStatus, AgentStatus> = {
    active: "working",
    completed: "complete",
    error: "error",
    abandoned: "idle",
  };
  return statusMap[agent.status];
}

/**
 * Unified hook that derives display title and agent status for an agent,
 * preferring live pane data when the agent has an active terminal pane.
 */
export function useAgentDisplay(
  agent: AgentInfo,
): { title: string; status: AgentStatus | undefined } {
  const liveAgent = useAppStore((s) =>
    agent.paneId ? s.paneAgentStatus[agent.paneId] ?? null : null,
  );
  const liveTitle = useAppStore((s) =>
    agent.paneId ? s.paneTitle[agent.paneId] ?? null : null,
  );

  const title = cleanLiveTitle(liveTitle) ?? agent.name ?? "Agent";
  const status = deriveStatus(agent, liveAgent);

  return { title, status };
}
