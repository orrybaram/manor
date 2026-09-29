import { useMemo } from "react";
import House from "lucide-react/dist/esm/icons/house";
import FolderGit2 from "lucide-react/dist/esm/icons/folder-git-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import type { ProjectInfo } from "../../store/project-store";
import type { CommandItem } from "./types";

/** One project's workspace rows, tagged with its id so scope can filter it. */
interface WorkspaceGroup {
  projectId: string;
  heading: string;
  items: CommandItem[];
}

interface UseWorkspaceCommandsParams {
  projects: ProjectInfo[];
  activeWorkspacePath: string | null;
  selectWorkspace: (projectId: string, workspaceIndex: number) => void;
  onClose: () => void;
  onNewWorkspace?: (opts?: {
    projectId?: string;
    name?: string;
    branch?: string;
  }) => void;
}

export function useWorkspaceCommands({
  projects,
  activeWorkspacePath,
  selectWorkspace,
  onClose,
  onNewWorkspace,
}: UseWorkspaceCommandsParams): {
  workspaceGroups: WorkspaceGroup[];
} {
  // One group per project, keyed by id rather than name: names can collide.
  const workspaceGroups = useMemo(() => {
    const groups: WorkspaceGroup[] = [];
    for (const project of projects) {
      const cmds: CommandItem[] = [];
      for (let wi = 0; wi < project.workspaces.length; wi++) {
        const workspace = project.workspaces[wi];
        const isActive = workspace.path === activeWorkspacePath;
        const displayName = workspace.name || workspace.branch || "main";
        cmds.push({
          id: `ws-${project.id}-${workspace.path}`,
          label: displayName,
          icon: workspace.isMain ? (
            <House size={14} />
          ) : (
            <FolderGit2 size={14} />
          ),
          group: project.name,
          isActive,
          action: () => {
            if (!isActive) {
              selectWorkspace(project.id, wi);
            }
            onClose();
          },
        });
      }
      cmds.push({
        id: `new-ws-${project.id}`,
        label: "New Workspace",
        icon: <Plus size={14} />,
        group: project.name,
        action: () => {
          onNewWorkspace?.({ projectId: project.id });
          onClose();
        },
      });
      groups.push({ projectId: project.id, heading: project.name, items: cmds });
    }
    // The group holding the active workspace leads; the rest keep their order.
    const isActiveGroup = (g: WorkspaceGroup) =>
      g.items.some((c) => c.isActive) ? 0 : 1;
    return groups.sort((a, b) => isActiveGroup(a) - isActiveGroup(b));
  }, [
    projects,
    activeWorkspacePath,
    selectWorkspace,
    onClose,
    onNewWorkspace,
  ]);

  return { workspaceGroups };
}
