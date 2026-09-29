import type { ReactNode } from "react";
import type { SettingsPageId } from "../settings/SettingsModal/SettingsModal";

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

/** Where the palette was opened from: keyboard/menu shortcut vs. the sidebar Search row. */
export type PaletteOrigin = "shortcut" | "search";

export interface CommandPaletteProps {
  open: boolean;
  /** Defaults to "shortcut". */
  origin?: PaletteOrigin;
  onClose: () => void;
  onOpenSettings?: (page?: SettingsPageId) => void;
  onOpenFeedback?: () => void;
  onNewWorkspace?: (opts?: {
    projectId?: string;
    name?: string;
    branch?: string;
    agentPrompt?: string;
    linkedIssue?: import("../../store/project-store").LinkedIssue;
  }) => void;
  onResumeAgent: (agent: import("../../electron.d").AgentInfo) => void;
  onViewAllAgents: () => void;
  onNewAgent: () => void;
  onNewAgentWithPrompt?: (prompt: string) => void;
  /** Run a command from the primary window's command map (`createMenuHandlers`). */
  runCommand?: (commandId: string) => void;
  initialView?: PaletteView;
  initialIssueId?: string | null;
  initialGitHubIssueNumber?: number | null;
}

export type PaletteView =
  | "root"
  | "linear-all"
  | "github-all"
  | "up-next"
  | "issue-detail"
  | "github-issue-detail"
  | "processes"
  | "stats";
