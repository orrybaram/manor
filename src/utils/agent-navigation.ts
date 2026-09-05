import type { AgentInfo } from "../electron.d";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { useAgentStore } from "../store/agent-store";
import { useToastStore } from "../store/toast-store";
import { hasPaneId } from "../store/pane-tree";

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
    // Find the tab containing agent.paneId by searching all panels
    const { workspaceLayouts } = useAppStore.getState();
    const layout = workspaceLayouts[agent.workspacePath];
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
        workspacePath: agent.workspacePath,
        tabId,
        paneId: agent.paneId,
      });
    }
  }

  window.electronAPI?.agents.markSeen(agent.id);
  useAgentStore.getState().markAgentSeen(agent.id);
  useToastStore.getState().removeToast(`agent-input-${agent.id}`);
}
