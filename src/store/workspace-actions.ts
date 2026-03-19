import { useAppStore } from "./app-store";
import { useProjectStore } from "./project-store";
import { useToastStore } from "./toast-store";
import type { ProjectInfo, WorkspaceInfo } from "./project-store";

/**
 * Remove a worktree: immediately switch away (if active), clean up sessions,
 * show a progress toast, and tear down in the background.
 */
export function removeWorktreeWithToast(
  project: ProjectInfo,
  ws: WorkspaceInfo,
  deleteBranch?: boolean,
): void {
  const appStore = useAppStore.getState();
  const projectStore = useProjectStore.getState();
  const toastStore = useToastStore.getState();

  const wasActive = appStore.activeWorkspacePath === ws.path;
  const wsName = ws.name || ws.branch || ws.path.split("/").pop() || "workspace";

  // Immediately switch to next workspace before teardown
  if (wasActive) {
    const workspaces = project.workspaces;
    const removedIdx = workspaces.findIndex((w) => w.path === ws.path);
    // Pick the next workspace, or the one before if we're removing the last
    const nextIdx = removedIdx < workspaces.length - 1 ? removedIdx + 1 : removedIdx - 1;
    if (nextIdx >= 0) {
      projectStore.selectWorkspace(project.id, nextIdx);
      appStore.setActiveWorkspace(workspaces[nextIdx].path);
    }
  }

  // Clean up sessions
  appStore.removeWorkspaceSessions(ws.path);

  // Show toast and run async teardown
  const toastId = `toast-${crypto.randomUUID()}`;
  toastStore.addToast({
    id: toastId,
    message: `Removing "${wsName}"...`,
    status: "loading",
    detail: "Tearing down worktree",
  });

  projectStore
    .removeWorktree(project.id, ws.path, deleteBranch)
    .then(() => {
      toastStore.updateToast(toastId, {
        message: `Removed "${wsName}"`,
        status: "success",
        detail: undefined,
      });
    })
    .catch((err) => {
      toastStore.updateToast(toastId, {
        message: `Failed to remove "${wsName}"`,
        status: "error",
        detail: String(err),
      });
    });
}
