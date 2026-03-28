import { useState, useCallback } from "react";
import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";

import { ManorLogo } from "../../ui/ManorLogo";
import { AboutModal } from "../AboutModal/AboutModal";
import { LinkedIssuesPopover } from "../LinkedIssuesPopover/LinkedIssuesPopover";
import { LinearIcon } from "../../command-palette/LinearIcon";
import { GitHubIcon } from "../../command-palette/GitHubIcon";
import type { LinkedIssue } from "../../../store/project-store";
import type { CommandPaletteProps } from "../../command-palette/types";
import styles from "./StatusBar.module.css";

function isGitHubIssue(issue: LinkedIssue): boolean {
  return issue.id.startsWith("gh-");
}

type LinkedIssueIconProps = {
  issues: LinkedIssue[];
  size: number;
};

function LinkedIssueIcon(props: LinkedIssueIconProps) {
  const { issues, size } = props;

  const hasGitHub = issues.some(isGitHubIssue);
  const hasLinear = issues.some((i) => !isGitHubIssue(i));

  if (hasGitHub && hasLinear) {
    return (
      <>
        <GitHubIcon size={size} />
        <LinearIcon size={size} />
      </>
    );
  }
  if (hasGitHub) {
    return <GitHubIcon size={size} />;
  }
  return <LinearIcon size={size} />;
}

interface StatusBarProps {
  onNewWorkspace?: CommandPaletteProps["onNewWorkspace"];
  onNewTaskWithPrompt?: (prompt: string) => void;
}

export function StatusBar(props: StatusBarProps) {
  const { onNewWorkspace, onNewTaskWithPrompt } = props;

  const [aboutOpen, setAboutOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const webviewFocusedPaneId = useAppStore((s) => s.webviewFocusedPaneId);
  const projects = useProjectStore((s) => s.projects);

  const project = projects.find((p) =>
    p.workspaces.some((w) => w.path === activeWorkspacePath),
  );

  const workspace = project?.workspaces.find(
    (w) => w.path === activeWorkspacePath,
  );

  const workspaceLabel = workspace
    ? (workspace.name ?? workspace.branch)
    : null;

  const linkedIssues = workspace?.linkedIssues ?? [];

  const handlePopoverClose = useCallback(() => setPopoverOpen(false), []);

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        {project && (
          <>
            <span className={styles.segment}>{project.name}</span>
            {workspaceLabel && (
              <>
                <span className={styles.separator}>&gt;</span>
                <span className={styles.segment}>{workspaceLabel}</span>
              </>
            )}
            {linkedIssues.length > 0 && (
              <>
                <span className={styles.ticketSpacer} />
                <LinkedIssuesPopover
                  issues={linkedIssues}
                  isOpen={popoverOpen}
                  onClose={handlePopoverClose}
                  projectId={project.id}
                  workspacePath={workspace!.path}
                  onNewWorkspace={onNewWorkspace}
                  onNewTaskWithPrompt={onNewTaskWithPrompt}
                >
                  <button
                    className={styles.linearSection}
                    onClick={() => setPopoverOpen((prev) => !prev)}
                  >
                    <LinkedIssueIcon issues={linkedIssues} size={12} />
                    <span>
                      {linkedIssues.length === 1
                        ? linkedIssues[0].identifier
                        : `${linkedIssues.length} issues`}
                    </span>
                  </button>
                </LinkedIssuesPopover>
              </>
            )}
          </>
        )}
        {webviewFocusedPaneId && (
          <div className={styles.browserFocusBadge}>
            <span className={styles.browserFocusLabel}>BROWSER</span>
            <span className={styles.browserFocusHint}>(Esc Esc to return focus)</span>
          </div>
        )}
      </div>
      <div className={styles.right}>
        <button
          className={styles.logoButton}
          onClick={() => setAboutOpen(true)}
          aria-label="About Manor"
        >
          <ManorLogo />
        </button>
      </div>
      <AboutModal open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  );
}
