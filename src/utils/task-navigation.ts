import type { TaskInfo } from "../electron.d";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";

export function navigateToTask(task: TaskInfo) {
  const { selectProject, setProjectExpanded, selectWorkspace, projects } =
    useProjectStore.getState();
  const { setActiveWorkspace, selectSession, focusPane, workspaceSessions } =
    useAppStore.getState();

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
    setActiveWorkspace(task.workspacePath);
  }
  if (sessionId) {
    selectSession(sessionId);
  }
  if (task.paneId) {
    focusPane(task.paneId);
  }
}
