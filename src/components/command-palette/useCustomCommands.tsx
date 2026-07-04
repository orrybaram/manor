import { useMemo } from "react";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Play from "lucide-react/dist/esm/icons/play";
import Wrench from "lucide-react/dist/esm/icons/wrench";
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
  const addTerminalTab = useAppStore((s) => s.addTerminalTab);

  return useMemo(() => {
    if (!activeWorkspacePath) return [];
    const project = projects.find((p) =>
      p.workspaces.some((w) => w.path === activeWorkspacePath),
    );
    if (!project) return [];

    const runInNewTab = (command: string) => {
      // addTerminalTab scopes the pending command to the new tab's own pane,
      // so it runs regardless of the pane's resolved cwd (unlike the
      // workspace-scoped setPendingStartupCommand, which only fires for the
      // first tab of a freshly-opened worktree).
      addTerminalTab(command);
      onClose();
    };

    const items: CommandItem[] = (project.commands ?? []).map((cmd) => ({
      id: `custom-cmd-${cmd.id}`,
      label: cmd.name || cmd.command,
      icon: <Terminal size={14} />,
      action: () => runInNewTab(cmd.command),
    }));

    if (project.worktreeStartScript?.trim()) {
      const script = project.worktreeStartScript;
      items.push({
        id: "custom-cmd-setup-script",
        label: "Run Setup Script",
        icon: <Play size={14} />,
        keywords: ["setup", "start", "worktree", "script"],
        action: () => runInNewTab(script),
      });
    }

    if (project.worktreeTeardownScript?.trim()) {
      const script = project.worktreeTeardownScript;
      items.push({
        id: "custom-cmd-teardown-script",
        label: "Run Teardown Script",
        icon: <Wrench size={14} />,
        keywords: ["teardown", "cleanup", "worktree", "script"],
        action: () => runInNewTab(script),
      });
    }

    return items;
  }, [projects, activeWorkspacePath, addTerminalTab, onClose]);
}
