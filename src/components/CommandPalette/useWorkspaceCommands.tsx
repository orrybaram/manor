import { useMemo } from "react";
import { House, FolderGit2, Plus } from "lucide-react";
import type { ProjectInfo } from "../../store/project-store";
import type { CommandItem } from "./types";

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
  workspaceGroups: Map<string, CommandItem[]>;
} {
  const workspaceCommands: CommandItem[] = useMemo(() => {
    const cmds: CommandItem[] = [];
    for (const project of projects) {
      for (let wi = 0; wi < project.workspaces.length; wi++) {
        const workspace = project.workspaces[wi];
        const isActive = workspace.path === activeWorkspacePath;
        const displayName = workspace.name || workspace.branch || "main";
        cmds.push({
          id: `ws-${project.id}-${wi}`,
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
    }
    return cmds;
  }, [
    projects,
    activeWorkspacePath,
    selectWorkspace,
    onClose,
    onNewWorkspace,
  ]);

  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, CommandItem[]>();
    for (const cmd of workspaceCommands) {
      const group = cmd.group || "Workspaces";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(cmd);
    }
    const sorted = [...groups.entries()].sort(([, a], [, b]) => {
      const aActive = a.some((c) => c.isActive) ? 0 : 1;
      const bActive = b.some((c) => c.isActive) ? 0 : 1;
      return aActive - bActive;
    });
    return new Map(sorted);
  }, [workspaceCommands]);

  return { workspaceGroups };
}
