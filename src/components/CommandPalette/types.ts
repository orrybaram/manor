import type { ReactNode } from "react";

export interface CommandItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  group?: string;
  isActive?: boolean;
  action: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
  onNewWorkspace?: (opts?: {
    projectId?: string;
    name?: string;
    branch?: string;
  }) => void;
  onResumeTask: (task: import("../../electron.d").TaskInfo) => void;
  onViewAllTasks: () => void;
  onNewTask: () => void;
}

export type PaletteView = "root" | "linear" | "issue-detail";
