import type { TaskInfo } from "../electron.d";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { useToastStore } from "../store/toast-store";
import { hasPaneId } from "../store/pane-tree";

export function navigateToTask(task: TaskInfo) {
  const { selectProject, setProjectExpanded, selectWorkspace, projects } =
    useProjectStore.getState();
  const { workspaceLayouts } = useAppStore.getState();

  // Find the project by projectId
  const projectIndex = projects.findIndex((p) => p.id === task.projectId);
  if (projectIndex < 0) return;
  const project = projects[projectIndex];

  // Find the workspace index by workspacePath
  const workspaceIndex = project.workspaces.findIndex(
    (ws) => ws.path === task.workspacePath,
  );
  if (workspaceIndex < 0) return;

  // Find the tab containing task.paneId by searching all panels
  let tabId: string | null = null;
  if (task.paneId && task.workspacePath) {
    const layout = workspaceLayouts[task.workspacePath];
    if (layout) {
      for (const panel of Object.values(layout.panels)) {
        for (const tab of panel.tabs) {
          if (hasPaneId(tab.rootNode, task.paneId)) {
            tabId = tab.id;
            break;
          }
        }
        if (tabId) break;
      }
    }
  }

  selectProject(projectIndex);
  setProjectExpanded(project.id);
  selectWorkspace(project.id, workspaceIndex);
  if (task.workspacePath) {
    // Select tab + focus pane in a single atomic update so they
    // read the correct activeWorkspacePath and selectedTabId
    if (tabId || task.paneId) {
      useAppStore.setState((state) => {
        const wsPath = task.workspacePath!;
        const layout = state.workspaceLayouts[wsPath];
        if (!layout) return state;

        const panel = layout.panels[layout.activePanelId];
        if (!panel) return state;

        const updatedPanel = { ...panel };
        if (tabId) {
          updatedPanel.selectedTabId = tabId;
        }
        if (task.paneId) {
          const targetTabId = tabId ?? panel.selectedTabId;
          updatedPanel.tabs = updatedPanel.tabs.map((s) =>
            s.id === targetTabId
              ? { ...s, focusedPaneId: task.paneId! }
              : s,
          );
        }

        return {
          activeWorkspacePath: wsPath,
          workspaceLayouts: {
            ...state.workspaceLayouts,
            [wsPath]: {
              ...layout,
              panels: {
                ...layout.panels,
                [layout.activePanelId]: updatedPanel,
              },
            },
          },
        };
      });
    }
  }
  window.electronAPI?.tasks.markSeen(task.id);
  useTaskStore.getState().markTaskSeen(task.id);
  useToastStore.getState().removeToast(`task-input-${task.id}`);
}
