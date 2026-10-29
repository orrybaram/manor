import type { AgentInfo } from "../electron.d";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useToastStore } from "../store/toast-store";
import { useLaunchedSessions } from "../store/launched-sessions-store";
import { agentWorkspaceKey, navigateToAgent } from "../utils/agent-navigation";
import { paneHasNoAgent, resumeAgentInPane } from "./agent-resume-in-pane";
import { isHomePath } from "./home";
import { hasPaneId } from "./layout/pane-tree";
import { parseWorkspaceKey } from "./workspace-key";

/**
 * Focus the pane `agent` runs in. If that pane came back as a bare shell
 * (the terminal session was lost), bring the agent back there rather than
 * show it empty.
 */
export function goToAgentPane(agent: AgentInfo): void {
  navigateToAgent(agent);
  if (!agent.paneId) return;
  const paneStatus = useAppStore.getState().paneAgentStatus[agent.paneId];
  if (paneHasNoAgent(paneStatus)) void resumeAgentInPane(agent);
}

/**
 * Bring `agent` back: focus its pane when it still has one, else open a tab
 * in its workspace running its `--resume` command.
 */
export function resumeAgent(agent: AgentInfo): void {
  const { projects } = useProjectStore.getState();
  // The agent's workspace, on its host.
  const agentKey = agentWorkspaceKey(agent, projects);
  // If the agent is active and has a pane, switch to it instead of opening a new tab
  if (agent.status === "active" && agent.paneId && agentKey) {
    const wsLayout = useAppStore.getState().workspaceLayouts[agentKey];
    if (wsLayout) {
      const paneExists = Object.values(wsLayout.panels).some((panel) =>
        panel.tabs.some((tab) => hasPaneId(tab.rootNode, agent.paneId!)),
      );
      if (paneExists) {
        goToAgentPane(agent);
        return;
      }
    }
  }

  const wsPath = agent.workspacePath;
  // The Dashboard hosts no panes, so a Home agent has
  // nowhere to resume into.
  if (isHomePath(wsPath)) {
    useToastStore.getState().addToast({
      id: `resume-home-agent-${agent.id}`,
      message: "Dashboard agents can't be resumed",
      status: "info",
    });
    return;
  }
  void resumeInNewTab(agent, wsPath, agentKey);
}

/**
 * Open a tab in the agent's workspace (else the active one) running its
 * kind's resume command, quoted, as main builds it for any kind.
 */
async function resumeInNewTab(
  agent: AgentInfo,
  wsPath: string | null,
  agentKey: ReturnType<typeof agentWorkspaceKey>,
): Promise<void> {
  const workspacePath = wsPath ?? useAppStore.getState().activeWorkspacePath;
  if (!workspacePath) {
    useAppStore.getState().addTab();
    return;
  }
  let command: string | null = null;
  try {
    command = await window.electronAPI.agents.buildResumeCommand(agent.id);
  } catch {
    command = null;
  }
  if (!command) {
    useToastStore.getState().addToast({
      id: `resume-agent-${agent.id}`,
      message: "This agent's session can't be resumed",
      status: "error",
    });
    return;
  }
  const app = useAppStore.getState();
  if (wsPath && agentKey) app.setActiveWorkspace(wsPath, parseWorkspaceKey(agentKey).hostId);
  // Don't consume prewarmed — resume needs a specific resume command.
  // The line is queued on the server.
  const opened = useAppStore.getState().addTerminalTab(command, {
    kind: "agent-startup",
    agentKind: agent.agentKind,
  });
  // Its pane until the pane's Agent reports in (see `useLaunchedSessions`).
  if (opened) {
    useLaunchedSessions.getState().remember(`${agent.agentKind}:${agent.agentSessionId}`, opened.paneId);
  }
}
