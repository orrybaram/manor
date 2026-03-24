import { useMemo } from "react";
import { Terminal } from "lucide-react";
import { useProjectStore } from "../../store/project-store";
import { useAppStore, selectActiveWorkspace } from "../../store/app-store";
import type { CommandItem } from "./useWorkspaceCommands";

interface UseCustomCommandsParams {
  onClose: () => void;
  activeWorkspacePath: string | null;
}

export function useCustomCommands({ onClose, activeWorkspacePath }: UseCustomCommandsParams): CommandItem[] {
  const projects = useProjectStore((s) => s.projects);
  const ws = useAppStore(selectActiveWorkspace);
  const selectedSession = ws?.sessions.find((s) => s.id === ws.selectedSessionId);
  const focusedPaneId = selectedSession?.focusedPaneId ?? null;

  return useMemo(() => {
    if (!activeWorkspacePath) return [];
    const project = projects.find((p) =>
      p.workspaces.some((w) => w.path === activeWorkspacePath)
    );
    if (!project?.commands?.length) return [];

    return project.commands.map((cmd) => ({
      id: `custom-cmd-${cmd.id}`,
      label: cmd.name || cmd.command,
      icon: <Terminal size={14} />,
      action: () => {
        if (focusedPaneId) {
          window.electronAPI.pty.write(focusedPaneId, cmd.command + "\r");
        }
        onClose();
      },
    }));
  }, [projects, activeWorkspacePath, focusedPaneId, onClose]);
}
