import { useMemo, useRef } from "react";
import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import type { AgentState } from "../electron.d";

export interface WorkspaceAgent {
  paneId: string;
  sessionId: string;
  agent: AgentState;
}

/**
 * Returns all active agents (non-idle) across all sessions for a given workspace path.
 */
export function useWorkspaceAgents(workspacePath: string): WorkspaceAgent[] {
  const ws = useAppStore((s) => s.workspaceSessions[workspacePath]);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);

  const prevRef = useRef<WorkspaceAgent[]>(EMPTY);

  return useMemo(() => {
    if (!ws) return EMPTY;

    const agents: WorkspaceAgent[] = [];
    for (const session of ws.sessions) {
      for (const paneId of allPaneIds(session.rootNode)) {
        const agent = paneAgentStatus[paneId];
        if (agent && agent.status !== "idle") {
          agents.push({ paneId, sessionId: session.id, agent });
        }
      }
    }

    if (agents.length === 0) return EMPTY;

    // Return previous reference if contents haven't changed
    const prev = prevRef.current;
    if (
      prev.length === agents.length &&
      prev.every((p, i) => p.paneId === agents[i].paneId && p.agent === agents[i].agent)
    ) {
      return prev;
    }

    prevRef.current = agents;
    return agents;
  }, [ws, paneAgentStatus]);
}

const EMPTY: WorkspaceAgent[] = [];
