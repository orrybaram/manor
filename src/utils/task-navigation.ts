import type { TaskInfo } from "../electron.d";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { useTaskStore } from "../store/task-store";
import { allPaneIds } from "../store/pane-tree";

export function navigateToTask(task: TaskInfo) {
  const { selectProject, setProjectExpanded, selectWorkspace, projects } =
    useProjectStore.getState();
  const { setActiveWorkspace, workspaceSessions } = useAppStore.getState();

  // Find the project by projectId
  const projectIndex = projects.findIndex((p) => p.id === task.projectId);
  if (projectIndex < 0) return;
  const project = projects[projectIndex];

  // Find the workspace index by workspacePath
  const workspaceIndex = project.workspaces.findIndex(
    (ws) => ws.path === task.workspacePath,
  );
  if (workspaceIndex < 0) return;

  // Find the session containing task.paneId
  let sessionId: string | null = null;
  if (task.paneId && task.workspacePath) {
    const wsSessions = workspaceSessions[task.workspacePath];
    if (wsSessions) {
      for (const session of wsSessions.sessions) {
        if (allPaneIds(session.rootNode).includes(task.paneId)) {
          sessionId = session.id;
          break;
        }
      }
    }
  }

  selectProject(projectIndex);
  setProjectExpanded(project.id);
  selectWorkspace(project.id, workspaceIndex);
  if (task.workspacePath) {
    // Activate workspace first (may create workspace state via IPC)
    setActiveWorkspace(task.workspacePath);

    // Then select session + focus pane in a single atomic update so they
    // read the correct activeWorkspacePath and selectedSessionId
    if (sessionId || task.paneId) {
      useAppStore.setState((state) => {
        const wsPath = task.workspacePath!;
        const ws = state.workspaceSessions[wsPath];
        if (!ws) return state;

        const updatedWs = { ...ws };
        if (sessionId) {
          updatedWs.selectedSessionId = sessionId;
        }
        if (task.paneId) {
          const targetSessionId = sessionId ?? ws.selectedSessionId;
          updatedWs.sessions = updatedWs.sessions.map((s) =>
            s.id === targetSessionId
              ? { ...s, focusedPaneId: task.paneId! }
              : s,
          );
        }

        return {
          activeWorkspacePath: wsPath,
          workspaceSessions: {
            ...state.workspaceSessions,
            [wsPath]: updatedWs,
          },
        };
      });
    }
  }
  window.electronAPI?.tasks.markSeen(task.id);
  useTaskStore.getState().markTaskSeen(task.id);
}
