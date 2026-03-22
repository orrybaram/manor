import { useMemo, useRef } from "react";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";
import type { AgentState } from "../electron.d";

export interface GlobalAgent {
  paneId: string;
  sessionId: string;
  agent: AgentState;
  projectName: string;
  projectIndex: number;
  workspaceIndex: number;
  workspacePath: string;
}

const EMPTY: GlobalAgent[] = [];

/**
 * Returns all active agents (non-idle) across ALL projects and workspaces.
 */
export function useAllAgents(): GlobalAgent[] {
  const projects = useProjectStore((s) => s.projects);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const workspaceSessions = useAppStore((s) => s.workspaceSessions);

  const prevRef = useRef<GlobalAgent[]>(EMPTY);

  return useMemo(() => {
    const agents: GlobalAgent[] = [];

    for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
      const project = projects[projectIndex];
      for (let workspaceIndex = 0; workspaceIndex < project.workspaces.length; workspaceIndex++) {
        const ws = project.workspaces[workspaceIndex];
        const wsState = workspaceSessions[ws.path];
        if (!wsState) continue;

        for (const session of wsState.sessions) {
          for (const paneId of allPaneIds(session.rootNode)) {
            const agent = paneAgentStatus[paneId];
            if (agent && agent.status !== "idle") {
              agents.push({
                paneId,
                sessionId: session.id,
                agent,
                projectName: project.name,
                projectIndex,
                workspaceIndex,
                workspacePath: ws.path,
              });
            }
          }
        }
      }
    }

    if (agents.length === 0) return EMPTY;

    // Return previous reference if contents haven't changed
    const prev = prevRef.current;
    if (
      prev.length === agents.length &&
      prev.every(
        (p, i) =>
          p.paneId === agents[i].paneId &&
          p.agent === agents[i].agent &&
          p.projectIndex === agents[i].projectIndex &&
          p.workspaceIndex === agents[i].workspaceIndex,
      )
    ) {
      return prev;
    }

    prevRef.current = agents;
    return agents;
  }, [projects, paneAgentStatus, workspaceSessions]);
}
