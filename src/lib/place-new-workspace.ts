import { useProjectStore } from "../store/project-store";
import { buildSidebarItems, placeInFolder } from "../utils/sidebar-items";

/**
 * Move a just-created workspace into a sidebar folder.
 *
 * Reads the project fresh from the store: by the time the create call
 * resolves, the store has already merged the new worktree and normalised the
 * sidebar order, and the folder placement must build on that tree rather than
 * the one the dialog opened with. A folder the user deleted mid-dialog is
 * simply not found, and the workspace stays loose.
 */
export async function placeNewWorkspaceInFolder(
  projectId: string,
  workspacePath: string,
  folderId: string,
): Promise<void> {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return;
  await store.applySidebarChange(
    projectId,
    placeInFolder(buildSidebarItems(project), workspacePath, folderId),
  );
}
