import { useMemo } from "react";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import { useProjectStore } from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import type { CommandItem } from "./types";

interface UseCustomCommandsParams {
  onClose: () => void;
  activeWorkspacePath: string | null;
}

export function useCustomCommands({
  onClose,
  activeWorkspacePath,
}: UseCustomCommandsParams): CommandItem[] {
  const projects = useProjectStore((s) => s.projects);
  const addSession = useAppStore((s) => s.addSession);

  return useMemo(() => {
    if (!activeWorkspacePath) return [];
    const project = projects.find((p) =>
      p.workspaces.some((w) => w.path === activeWorkspacePath),
    );
    if (!project?.commands?.length) return [];

    return project.commands.map((cmd) => ({
      id: `custom-cmd-${cmd.id}`,
      label: cmd.name || cmd.command,
      icon: <Terminal size={14} />,
      action: () => {
        useAppStore
          .getState()
          .setPendingStartupCommand(activeWorkspacePath, cmd.command);
        addSession();
        onClose();
      },
    }));
  }, [projects, activeWorkspacePath, addSession, onClose]);
}
