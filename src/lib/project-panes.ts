import type { ProjectInfo } from "../store/project-store";
import { workspaceKey } from "./workspace-key";

/** Whether any workspace of `project` has an open tab in this window. */
export function projectHasOpenPanes(
  project: ProjectInfo,
  workspaceLayouts: Record<string, { panels: Record<string, { tabs: unknown[] }> }>,
): boolean {
  return project.workspaces.some((ws) => {
    const layout = workspaceLayouts[workspaceKey(project.hostId, ws.path)];
    if (!layout) return false;
    return Object.values(layout.panels).some((panel) => panel.tabs.length > 0);
  });
}
