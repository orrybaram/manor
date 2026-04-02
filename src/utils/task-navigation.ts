import type { TaskInfo } from "../electron.d";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { hasPaneId } from "../store/pane-tree";

export function navigateToTask(task: TaskInfo) {
  const { selectProject, setProjectExpanded, selectWorkspace, projects } =
    useProjectStore.getState();
  const { workspaceTabs } = useAppStore.getState();

  // Find the project by projectId
  const projectIndex = projects.findIndex((p) => p.id === task.projectId);
  if (projectIndex < 0) return;
  const project = projects[projectIndex];

  // Find the workspace index by workspacePath
  const workspaceIndex = project.workspaces.findIndex(
    (ws) => ws.path === task.workspacePath,
  );
  if (workspaceIndex < 0) return;

  // Find the tab containing task.paneId
  let tabId: string | null = null;
  if (task.paneId && task.workspacePath) {
    const wsTabs = workspaceTabs[task.workspacePath];
    if (wsTabs) {
      for (const tab of wsTabs.tabs) {
        if (hasPaneId(tab.rootNode, task.paneId)) {
          tabId = tab.id;
          break;
        }
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
        const ws = state.workspaceTabs[wsPath];
        if (!ws) return state;

        const updatedWs = { ...ws };
        if (tabId) {
          updatedWs.selectedTabId = tabId;
        }
        if (task.paneId) {
          const targetTabId = tabId ?? ws.selectedTabId;
          updatedWs.tabs = updatedWs.tabs.map((s) =>
            s.id === targetTabId
              ? { ...s, focusedPaneId: task.paneId! }
              : s,
          );
        }

        return {
          activeWorkspacePath: wsPath,
          workspaceTabs: {
            ...state.workspaceTabs,
            [wsPath]: updatedWs,
          },
        };
      });
    }
  }
  window.electronAPI?.tasks.markSeen(task.id);
  useTaskStore.getState().markTaskSeen(task.id);
}
