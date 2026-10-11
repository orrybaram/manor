import type { AgentInfo } from "../../electron.d";
import type { HostId } from "../../lib/hosts";

/** How many past agents the empty workspace offers to jump back into. */
export const RECENT_AGENT_LIMIT = 8;

/** "Good morning" / "Good afternoon" / "Good evening" for the hour `date` is in. */
export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The agents that ran in the workspace at `workspacePath` on `hostId`, most
 * recently touched first, at most `RECENT_AGENT_LIMIT` of them.
 */
export function recentWorkspaceAgents(
  agents: readonly AgentInfo[],
  workspacePath: string | null,
  hostId: HostId,
): AgentInfo[] {
  if (!workspacePath) return [];
  return agents
    .filter((a) => a.workspacePath === workspacePath && a.hostId === hostId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, RECENT_AGENT_LIMIT);
}

export type RecentTone = "done" | "error" | "neutral";

/** The card's status line for an agent's lifecycle. */
export function recentStatus(agent: AgentInfo): { label: string; tone: RecentTone } {
  switch (agent.status) {
    case "completed":
      return { label: "Finished", tone: "done" };
    case "error":
      return { label: "Errored", tone: "error" };
    case "abandoned":
      return { label: "Interrupted", tone: "neutral" };
    default:
      return { label: "Paused", tone: "neutral" };
  }
}
