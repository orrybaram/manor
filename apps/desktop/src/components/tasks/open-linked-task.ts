import { useProjectStore } from "../../store/project-store";
import type { LinkedTask } from "../../lib/tasks";

/**
 * Go to the workspace a linked task is in progress in. Also flips
 * `activeSurface` back to "workspace" via `setActiveWorkspace`. Shared by the
 * Tasks view and Home's Up next.
 */
export function openLinkedTask(task: LinkedTask): void {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === task.projectId);
  const index =
    project?.workspaces.findIndex((ws) => ws.path === task.workspacePath) ?? -1;
  if (index >= 0) store.selectWorkspace(task.projectId, index);
}
