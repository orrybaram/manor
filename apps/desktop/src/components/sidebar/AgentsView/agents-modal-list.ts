import type { AgentInfo } from "../../../electron.d";
import { matchesAgentQuery } from "../../../lib/agent-query";
import { resolveAgentTitle } from "../../../hooks/useAgentDisplay";

/** The modal's tabs. Open: the agent's pane is in a workspace right now. */
export type AgentTab = "all" | "open" | "closed";

export function isAgentOpen(agent: AgentInfo, openPaneIds: ReadonlySet<string>): boolean {
  return agent.paneId !== null && openPaneIds.has(agent.paneId);
}

/**
 * The rows the Agents modal lists, newest first. With a query, main's search
 * page joins the store's agents (the store's copy of an agent wins, being
 * live), and both are filtered here too: by the shown title, which only the
 * window knows, and against a search page from an older query.
 */
export function agentsModalRows(input: {
  storeAgents: readonly AgentInfo[];
  searchAgents: readonly AgentInfo[];
  query: string;
  tab: AgentTab;
  openPaneIds: ReadonlySet<string>;
  liveTitles: Readonly<Record<string, string>>;
}): AgentInfo[] {
  const { storeAgents, searchAgents, tab, openPaneIds, liveTitles } = input;
  const query = input.query.trim();

  let agents: AgentInfo[] = [...storeAgents];
  if (query) {
    const ids = new Set(agents.map((a) => a.id));
    for (const a of searchAgents) if (!ids.has(a.id)) agents.push(a);
    agents = agents.filter((a) => {
      const liveTitle = a.paneId ? liveTitles[a.paneId] ?? null : null;
      return (
        matchesAgentQuery(a, query) ||
        matchesAgentQuery({ ...a, name: resolveAgentTitle(a, liveTitle) }, query)
      );
    });
  }
  if (tab !== "all") {
    const wantOpen = tab === "open";
    agents = agents.filter((a) => isAgentOpen(a, openPaneIds) === wantOpen);
  }
  return agents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
