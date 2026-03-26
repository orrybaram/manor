import type { ReactNode } from "react";

export interface CommandItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  keywords?: string[];
  group?: string;
  isActive?: boolean;
  suffix?: ReactNode;
  action: () => void;
}

export interface CategoryConfig {
  id: string;
  heading: string;
  visible: boolean;
  items: CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
  onNewWorkspace?: (opts?: {
    projectId?: string;
    name?: string;
    branch?: string;
    agentPrompt?: string;
    linkedIssue?: import("../../store/project-store").LinkedIssue;
  }) => void;
  onResumeTask: (task: import("../../electron.d").TaskInfo) => void;
  onViewAllTasks: () => void;
  onNewTask: () => void;
  onNewTaskWithPrompt?: (prompt: string) => void;
  initialView?: PaletteView;
  initialIssueId?: string | null;
  initialGitHubIssueNumber?: number | null;
}

export type PaletteView =
  | "root"
  | "linear"
  | "linear-all"
  | "github"
  | "github-all"
  | "issue-detail"
  | "github-issue-detail";
