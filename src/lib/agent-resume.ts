import { DEFAULT_AGENT_COMMAND } from "../agent-defaults";
import type { AgentInfo } from "../electron.d";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useToastStore } from "../store/toast-store";
import { agentWorkspaceKey, navigateToAgent } from "../utils/agent-navigation";
import { paneHasNoAgent, resumeAgentInPane } from "./agent-resume-in-pane";
import { isHomePath } from "./home";
import { hasPaneId } from "./layout/pane-tree";
import { ownerOf } from "./workspace-directory";
import { parseWorkspaceKey } from "./workspace-key";

/**
 * Bring `agent` back: focus its pane when it still has one, else open a tab
 * in its workspace running its `--resume` command.
 */
export function resumeAgent(agent: AgentInfo): void {
  const { projects } = useProjectStore.getState();
  // The agent's workspace, on its host (ADR-191).
  const agentKey = agentWorkspaceKey(agent, projects);
  // If the agent is active and has a pane, switch to it instead of opening a new tab
  if (agent.status === "active" && agent.paneId && agentKey) {
    const wsLayout = useAppStore.getState().workspaceLayouts[agentKey];
    if (wsLayout) {
      const paneExists = Object.values(wsLayout.panels).some((panel) =>
        panel.tabs.some((tab) => hasPaneId(tab.rootNode, agent.paneId!)),
      );
      if (paneExists) {
        navigateToAgent(agent);
        // Its pane came back as a bare shell (the terminal session was
        // lost): bring the agent back there rather than show it empty.
        const paneStatus = useAppStore.getState().paneAgentStatus[agent.paneId];
        if (paneHasNoAgent(paneStatus)) void resumeAgentInPane(agent);
        return;
      }
    }
  }

  const wsPath = agent.workspacePath;
  // The Dashboard hosts no panes (ADR-197 §2), so a Home agent has
  // nowhere to resume into.
  if (isHomePath(wsPath)) {
    useToastStore.getState().addToast({
      id: `resume-home-agent-${agent.id}`,
      message: "Dashboard agents can't be resumed",
      status: "info",
    });
    return;
  }
  const app = useAppStore.getState();
  if (wsPath && agentKey) {
    app.setActiveWorkspace(wsPath, parseWorkspaceKey(agentKey).hostId);
  }
  const activePath = wsPath ?? useAppStore.getState().activeWorkspacePath;
  if (activePath) {
    const agentProject = ownerOf(projects, agentKey);
    const agentCommand =
      agent.agentCommand ??
      agentProject?.agentCommand ??
      DEFAULT_AGENT_COMMAND;
    // Don't consume prewarmed — resume needs a specific --resume command.
    // The line is queued on the server (ADR-179 ticket 11).
    useAppStore
      .getState()
      .addTerminalTab(`${agentCommand} --resume ${agent.agentSessionId}`, {
        kind: "agent-startup",
      });
  } else {
    app.addTab();
  }
}
