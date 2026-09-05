import { useState, useCallback, useEffect } from "react";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Search from "lucide-react/dist/esm/icons/search";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Globe from "lucide-react/dist/esm/icons/globe";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { removeWorktreeWithToast } from "../../store/workspace-actions";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
import { useIssuesShortcut } from "./useIssuesShortcut";
import { WorkspaceSetupView } from "./WorkspaceSetupView";
import type { PaletteView } from "../command-palette/types";
import { GitHubNudge } from "./GitHubNudge";
import styles from "../EmptyState.module.css";

type WorkspaceEmptyStateProps = {
  onOpenPaletteView?: (view: PaletteView) => void;
  onNewWorkspace?: () => void;
};

/** Shown when the active workspace has no tabs. */
export function WorkspaceEmptyState(props: WorkspaceEmptyStateProps) {
  const { onOpenPaletteView, onNewWorkspace } = props;

  const addTab = useAppStore((s) => s.addTab);
  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const worktreeSetupState = useAppStore((s) => s.worktreeSetupState);
  const clearWorktreeSetup = useAppStore((s) => s.clearWorktreeSetup);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);

  const project = projects[selectedProjectIndex];
  const workspace = project?.workspaces[project.selectedWorkspaceIndex];
  const isWorktree = workspace && !workspace.isMain;

  const isMain = workspace?.isMain ?? false;

  const {
    action: issuesAction,
    showGitHubNudge,
    onGitHubInstalled,
  } = useIssuesShortcut(onOpenPaletteView);

  const actions: ActionItem[] = [
    ...(isMain && onNewWorkspace
      ? [
          {
            icon: <FolderPlus size={16} />,
            label: "New Workspace",
            keys: ["⌘", "⇧", "N"] as string[],
            action: onNewWorkspace,
          },
        ]
      : []),
    {
      icon: <Search size={16} />,
      label: "Command Palette",
      keys: ["⌘", "K"],
      action: () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        );
      },
    },
    {
      icon: <Plus size={16} />,
      label: "New Agent",
      keys: ["⌘", "N"],
      action: () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "n", metaKey: true }),
        );
      },
    },
    {
      icon: <Terminal size={16} />,
      label: "Open Terminal",
      keys: ["⌘", "T"],
      action: () => addTab(),
    },
    {
      icon: <Globe size={16} />,
      label: "New Browser Window",
      keys: ["⌘", "⇧", "B"],
      action: () => addBrowserTab("about:blank"),
    },
    ...(issuesAction ? [issuesAction] : []),
  ];

  if (isWorktree && project) {
    actions.push({
      icon: <Trash2 size={16} />,
      label: "Delete Worktree",
      keys: [],
      action: () => removeWorktreeWithToast(project, workspace),
      variant: "danger",
    });
  }

  const banner = showGitHubNudge ? (
    <GitHubNudge onInstalled={onGitHubInstalled} />
  ) : null;

  // Check for active worktree setup (try actual path, then pending key)
  const setupKey = activeWorkspacePath && worktreeSetupState[activeWorkspacePath]
    ? activeWorkspacePath
    : worktreeSetupState["__pending__"]
      ? "__pending__"
      : null;
  const setupState = setupKey ? worktreeSetupState[setupKey] : null;
  const setupActive = !!(setupState && !setupState.completed && setupKey);

  // Track transition phase: "setup" | "transitioning" | "done"
  const [phase, setPhase] = useState<"setup" | "transitioning" | "done">(
    setupActive ? "setup" : "done",
  );

  // When setup becomes active, switch to setup phase
  useEffect(() => {
    if (setupActive && phase === "done") {
      setPhase("setup");
    }
  }, [setupActive, phase]);

  const handleSetupComplete = useCallback(() => {
    // The orchestrator (startSetupScript in project-store) owns the success
    // toast now so it fires even when this view is unmounted. Here we only
    // drive the fade-out transition.
    setPhase("transitioning");
  }, []);

  const handleFadeInEnd = useCallback(() => {
    if (phase === "transitioning" && setupKey) {
      clearWorktreeSetup(setupKey);
      setPhase("done");
    }
  }, [phase, setupKey, clearWorktreeSetup]);

  if (phase === "setup" && setupKey) {
    return (
      <WorkspaceSetupView
        workspacePath={setupKey}
        onComplete={handleSetupComplete}
      />
    );
  }

  return (
    <div
      className={phase === "transitioning" ? styles.fadeIn : undefined}
      onAnimationEnd={handleFadeInEnd}
      style={{ height: "100%" }}
    >
      <EmptyStateShell actions={actions} banner={banner} />
    </div>
  );
}
