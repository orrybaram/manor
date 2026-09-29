import { useCallback } from "react";
import { useProjectStore, type ProjectInfo, type WorkspaceInfo } from "../../../store/project-store";

/**
 * "Open workspace" for every dashboard section (ADR-198 §4): select
 * `workspace`'s project, then the workspace itself, by index in the live
 * store. A project or workspace that has since gone away is a no-op, and
 * the callback returns false so a follow-up (opening its diff) can skip.
 */
export function useSelectWorkspace(): (project: ProjectInfo, workspace: WorkspaceInfo) => boolean {
  const projects = useProjectStore((s) => s.projects);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  return useCallback(
    (project: ProjectInfo, workspace: WorkspaceInfo) => {
      const projectIndex = projects.findIndex((p) => p.id === project.id);
      if (projectIndex < 0) return false;
      const workspaceIndex = project.workspaces.findIndex((w) => w.path === workspace.path);
      if (workspaceIndex < 0) return false;
      selectProject(projectIndex);
      selectWorkspace(project.id, workspaceIndex);
      return true;
    },
    [projects, selectProject, selectWorkspace],
  );
}
