import type { TaskInfo } from "../electron.d";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { useToastStore } from "../store/toast-store";
import { hasPaneId } from "../store/pane-tree";

export function navigateToTask(task: TaskInfo) {
  const { selectProject, setProjectExpanded, selectWorkspace, projects } =
    useProjectStore.getState();

  // Find the project by projectId
  const projectIndex = projects.findIndex((p) => p.id === task.projectId);
  if (projectIndex < 0) return;
  const project = projects[projectIndex];

  // Find the workspace index by workspacePath
  const workspaceIndex = project.workspaces.findIndex(
    (ws) => ws.path === task.workspacePath,
  );
  if (workspaceIndex < 0) return;

  // Activate project and workspace (handles IPC and layout initialization)
  selectProject(projectIndex);
  setProjectExpanded(project.id);
  selectWorkspace(project.id, workspaceIndex);

  if (task.workspacePath && task.paneId) {
    // Find the tab containing task.paneId by searching all panels
    const { workspaceLayouts } = useAppStore.getState();
    const layout = workspaceLayouts[task.workspacePath];
    let tabId: string | null = null;
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

    if (tabId) {
      // Atomically select tab and focus pane in one Zustand set() call
      useAppStore.getState().navigateToContext({
        workspacePath: task.workspacePath,
        tabId,
        paneId: task.paneId,
      });
    }
  }

  window.electronAPI?.tasks.markSeen(task.id);
  useTaskStore.getState().markTaskSeen(task.id);
  useToastStore.getState().removeToast(`task-input-${task.id}`);
}
