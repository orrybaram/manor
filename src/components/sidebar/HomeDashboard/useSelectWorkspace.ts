import { useCallback } from "react";
import { useProjectStore, type ProjectInfo, type WorkspaceInfo } from "../../../store/project-store";

/**
 * "Open workspace" for every dashboard section (ADR-198 §4): select
 * `workspace`'s project, then the workspace itself, by index in the live
 * store. A project or workspace that has since gone away is a no-op.
 */
export function useSelectWorkspace(): (project: ProjectInfo, workspace: WorkspaceInfo) => void {
  const projects = useProjectStore((s) => s.projects);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  return useCallback(
    (project: ProjectInfo, workspace: WorkspaceInfo) => {
      const projectIndex = projects.findIndex((p) => p.id === project.id);
      if (projectIndex < 0) return;
      const workspaceIndex = project.workspaces.findIndex((w) => w.path === workspace.path);
      if (workspaceIndex < 0) return;
      selectProject(projectIndex);
      selectWorkspace(project.id, workspaceIndex);
    },
    [projects, selectProject, selectWorkspace],
  );
}
