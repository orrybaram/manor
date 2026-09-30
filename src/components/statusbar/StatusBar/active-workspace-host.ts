import { selectActiveWorkspaceKey, type AppState } from "../../../store/app-store";
import { ownerOf, type DirectoryProject } from "../../../lib/workspace-directory";

/**
 * What the status bar's host chip speaks for: the active workspace's own
 * host (ADR-191 `activeWorkspaceHostId`) and the project that has that
 * workspace on that host, whose Host settings a click opens. Nothing
 * without an active workspace.
 *
 * Read from the workspace key, not from the path plus the selected project:
 * in a linked group (ADR-192) the same path can be a workspace on two hosts.
 */
export function activeWorkspaceHost(
  app: Pick<AppState, "activeWorkspacePath" | "activeWorkspaceHostId">,
  projects: readonly DirectoryProject[],
): { hostId: string | undefined; projectId: string | undefined } {
  const key = selectActiveWorkspaceKey(app);
  if (!key) return { hostId: undefined, projectId: undefined };
  return {
    hostId: app.activeWorkspaceHostId,
    projectId: ownerOf(projects, key)?.id,
  };
}
