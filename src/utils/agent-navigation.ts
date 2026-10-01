import type { AgentInfo } from "../electron.d";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { useToastStore } from "../store/toast-store";
import { hasPaneId } from "../lib/layout/pane-tree";
import { workspaceKey, type WorkspaceKey } from "../lib/workspace-key";
import { ownerOf } from "../lib/workspace-directory";
import type { ProjectInfo } from "../store/project-store";

/**
 * The key (ADR-191) of the workspace `agent` runs in: on the host its
 * terminal runs on (`agent.hostId`). A pane moved to another host (ADR-183)
 * still belongs to its project's workspace, so when no project on the
 * agent's host has the path, the key is on the agent's project's host.
 */
export function agentWorkspaceKey(
  agent: Pick<AgentInfo, "hostId" | "projectId" | "workspacePath">,
  projects: readonly ProjectInfo[],
): WorkspaceKey | null {
  const path = agent.workspacePath;
  if (!path) return null;
  const onAgentHost = workspaceKey(agent.hostId, path);
  if (ownerOf(projects, onAgentHost)) return onAgentHost;
  const project = projects.find((p) => p.id === agent.projectId);
  return project ? workspaceKey(project.hostId, path) : onAgentHost;
}

export function navigateToAgent(agent: AgentInfo) {
  const { selectProject, setProjectExpanded, selectWorkspace, projects } =
    useProjectStore.getState();

  // Find the project by projectId
  const projectIndex = projects.findIndex((p) => p.id === agent.projectId);
  if (projectIndex < 0) return;
  const project = projects[projectIndex];

  // Find the workspace index by workspacePath
  const workspaceIndex = project.workspaces.findIndex(
    (ws) => ws.path === agent.workspacePath,
  );
  if (workspaceIndex < 0) return;

  // Activate project and workspace (handles IPC and layout initialization)
  selectProject(projectIndex);
  setProjectExpanded(project.id);
  selectWorkspace(project.id, workspaceIndex);

  if (agent.workspacePath && agent.paneId) {
    // Find the tab containing agent.paneId by searching all panels of the
    // agent's workspace, on its host (ADR-191).
    const key = agentWorkspaceKey(agent, projects) ?? workspaceKey(project.hostId, agent.workspacePath);
    const layout = useAppStore.getState().workspaceLayouts[key];
    let tabId: string | null = null;
    if (layout) {
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          if (hasPaneId(tab.rootNode, agent.paneId)) {
            tabId = tab.id;
            break;
          }
        }
        if (tabId) break;
      }
    }

    if (tabId) {
      // Atomically select tab and focus pane in one Zustand set() call
      useAppStore.getState().navigateToContext({
        workspaceKey: key,
        tabId,
        paneId: agent.paneId,
      });
    }
  }

  window.electronAPI?.agents.markSeen(agent.id);
  useAgentStore.getState().markAgentSeen(agent.id);
  useToastStore.getState().removeToast(`agent-input-${agent.id}`);
}
