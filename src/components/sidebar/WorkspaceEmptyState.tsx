import { useState, useCallback } from "react";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Search from "lucide-react/dist/esm/icons/search";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Globe from "lucide-react/dist/esm/icons/globe";
import { selectActiveWorkspaceKey, useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { removeWorktreeWithToast } from "../../store/workspace-actions";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
import { useIssuesShortcut } from "./useIssuesShortcut";
import { WorkspaceSetupView } from "./WorkspaceSetupView";
import { GitHubNudge } from "./GitHubNudge";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { PhoneNewAgentComposer } from "../phone/NewAgent/PhoneNewAgentComposer";
import styles from "../EmptyState.module.css";

type WorkspaceEmptyStateProps = {
  onNewWorkspace?: () => void;
};

/** Shown when the active workspace has no tabs. */
export function WorkspaceEmptyState(props: WorkspaceEmptyStateProps) {
  const { onNewWorkspace } = props;

  const addTab = useAppStore((s) => s.addTab);
  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceKey = useAppStore(selectActiveWorkspaceKey);
  const worktreeSetupState = useAppStore((s) => s.worktreeSetupState);
  const clearWorktreeSetup = useAppStore((s) => s.clearWorktreeSetup);
  const projects = useProjectStore((s) => s.projects);
  const phone = useLayoutMode() === "phone";
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);

  const project = projects[selectedProjectIndex];
  const workspace = project?.workspaces[project.selectedWorkspaceIndex];
  const isWorktree = workspace && !workspace.isMain;

  const isMain = workspace?.isMain ?? false;

  const {
    action: issuesAction,
    showGitHubNudge,
    onGitHubInstalled,
  } = useIssuesShortcut();

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

  // Only the fade-out half of the transition is state; the setup phase itself
  // is derived from the store so a newly active setup enters it in the same
  // render rather than a follow-up effect.
  const [fade, setFade] = useState<"transitioning" | "done">("done");
  const phase: "setup" | "transitioning" | "done" =
    fade === "done" && setupActive ? "setup" : fade;

  const handleSetupComplete = useCallback(() => {
    // The setup script's success toast is `createWorktree`'s, which follows
    // the script the server runs. Here we only drive the
    // fade-out transition.
    setFade("transitioning");
  }, []);

  const handleFadeInEnd = useCallback(() => {
    if (phase === "transitioning" && setupKey) {
      clearWorktreeSetup(setupKey);
      setFade("done");
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

  // A phone has no use for a list of shortcuts: its empty workspace is a
  // chat that hasn't started yet. The first message is the new agent's
  // prompt, and nothing is launched until it is sent, so closing the last
  // agent lands back here rather than spawning another one. It is the
  // new-agent composer with nothing to close back to, keyed by
  // workspace so each workspace's screen starts on that workspace.
  const content = phone ? (
    <PhoneNewAgentComposer key={activeWorkspaceKey ?? ""} closable={false} />
  ) : (
    <EmptyStateShell actions={actions} banner={banner} />
  );

  return (
    <div
      className={phase === "transitioning" ? styles.fadeIn : undefined}
      onAnimationEnd={handleFadeInEnd}
      style={{ height: "100%" }}
    >
      {content}
    </div>
  );
}
