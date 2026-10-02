import { Fragment, lazy, Suspense, useState, useCallback, useMemo } from "react";
import {
  useAppStore,
  selectActiveWorkspaceKey,
  selectWebviewFocusVisible,
} from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { useTasksSummaryStore } from "../../../store/tasks-summary-store";

import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3";
import { ManorLogo } from "../../ui/ManorLogo";
import { hasJustUpdated } from "../../../lib/just-updated";
import { FeedbackModal } from "../FeedbackModal/FeedbackModal";
import { LinkedIssuesPopover } from "../LinkedIssuesPopover/LinkedIssuesPopover";
import { RemoteExposureIndicator } from "./RemoteExposureIndicator";
import { HostStatusIndicator } from "./HostStatusIndicator";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { useStatsStore, formatUnblockLatency } from "../../../store/stats-store";
import { LinearIcon } from "../../command-palette/LinearIcon";
import { GitHubIcon } from "../../command-palette/GitHubIcon";
import type { LinkedIssue, WorkspaceFolder } from "../../../store/project-store";
import type { CommandPaletteProps } from "../../command-palette/types";
import { find } from "../../../lib/workspace-directory";
import styles from "./StatusBar.module.css";

// The changelog and the markdown renderer behind it load with the first open.
const AboutModal = lazy(() =>
  import("../AboutModal/AboutModal").then((m) => ({ default: m.AboutModal })),
);

function isGitHubIssue(issue: LinkedIssue): boolean {
  return issue.id.startsWith("gh-");
}

/**
 * The folders enclosing a workspace, outermost first. Stops at a folder id
 * that names no folder, and at a parent cycle in a hand-edited file, so the
 * trail always ends.
 */
function folderTrail(
  folders: readonly WorkspaceFolder[],
  folderId: string | null | undefined,
): WorkspaceFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: WorkspaceFolder[] = [];
  const seen = new Set<string>();
  let current = folderId ? byId.get(folderId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return trail;
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
  /** Opens the command palette on the stats view (ADR-168 §6). */
  onOpenStats?: () => void;
}

interface StatsSegmentProps {
  onOpenStats?: () => void;
}

/**
 * Compact usage-stats readout (ADR-168 §6). Hidden while collection is off or
 * before anything worth showing has been recorded, so a fresh install never
 * sees a row of zeroes.
 */
function StatsSegment(props: StatsSegmentProps) {
  const { onOpenStats } = props;
  const summary = useStatsStore((s) => s.summary);

  const tooltip = useMemo(() => {
    if (!summary) return "";
    const { today } = summary;
    const parts = [
      `${today.prompts ?? 0} prompts`,
      `${today.toolCalls ?? 0} tool calls`,
      `${today.agentsKilled ?? 0} agents killed`,
    ];
    const latency = formatUnblockLatency(today);
    if (latency) parts.push(`${latency} to unblock`);
    return `Today — ${parts.join(", ")}`;
  }, [summary]);

  if (!summary || !summary.enabled) return null;
  const hasHistory =
    (summary.allTime.prompts ?? 0) > 0 || (summary.allTime.agentsKilled ?? 0) > 0;
  if (!hasHistory) return null;

  return (
    <Tooltip label={tooltip} side="top">
      <Button
        variant="link"
        className={styles.statsSegment}
        onClick={() => onOpenStats?.()}
        aria-label="Show stats"
      >
        <BarChart3 size={12} />
      </Button>
    </Tooltip>
  );
}

export function StatusBar(props: StatusBarProps) {
  const { onNewWorkspace, onOpenStats } = props;

  // An update that just landed opens About on its own, so the changelog for
  // the version now running is the first thing the user sees.
  const [aboutOpen, setAboutOpen] = useState(hasJustUpdated);
  // Mounted from the first open on, so closing still plays its exit.
  const [aboutMounted, setAboutMounted] = useState(aboutOpen);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const activeWorkspaceKey = useAppStore(selectActiveWorkspaceKey);
  const browserFocused = useAppStore(selectWebviewFocusVisible);
  const projects = useProjectStore((s) => s.projects);
  // The Tasks view (ADR-198) covers the active workspace, which stays active
  // underneath; its trail must not leak into the Tasks bar.
  const surface = useAppStore((s) => s.activeSurface);
  // With zero projects the onboarding screen replaces everything.
  const onboardingShown = projects.length === 0;
  const tasksShown = surface === "tasks" && !onboardingShown;

  const found =
    onboardingShown || tasksShown || !activeWorkspaceKey
      ? undefined
      : find(projects, activeWorkspaceKey);
  const project = found?.project;
  const workspace = found?.workspace;
  const tasksSummary = useTasksSummaryStore((s) => s.summary);

  const workspaceLabel = workspace
    ? (workspace.name ?? workspace.branch)
    : null;

  const folders = folderTrail(project?.folders ?? [], workspace?.folderId);

  const linkedIssues = workspace?.linkedIssues ?? [];

  const handlePopoverClose = useCallback(() => setPopoverOpen(false), []);

  return (
    <div className={styles.statusBar} data-focus-region="statusbar">
      <div className={styles.left}>
        {tasksShown && tasksSummary && (
          <span className={styles.segment}>{tasksSummary}</span>
        )}
        {project && (
          <>
            <span className={styles.segment}>{project.name}</span>
            {folders.map((folder) => (
              <Fragment key={folder.id}>
                <span className={styles.separator}>&gt;</span>
                <span className={styles.segment}>{folder.name}</span>
              </Fragment>
            ))}
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
                >
                  <button
                    className={styles.linearSection}
                    onClick={() => setPopoverOpen((prev) => !prev)}
                  >
                    <LinkedIssueIcon issues={linkedIssues} size={12} />
                    <span>
                      {linkedIssues.length === 1
                        ? linkedIssues[0].identifier
                        : `${linkedIssues.length} tasks`}
                    </span>
                  </button>
                </LinkedIssuesPopover>
              </>
            )}
          </>
        )}
        {browserFocused && (
          <div className={styles.browserFocusBadge}>
            <span className={styles.browserFocusLabel}>BROWSER</span>
            <span className={styles.browserFocusHint}>(Esc Esc to return focus)</span>
          </div>
        )}
      </div>
      <div className={styles.right}>
        <HostStatusIndicator />
        <RemoteExposureIndicator />
        <StatsSegment onOpenStats={onOpenStats} />
        <button
          className={styles.logoButton}
          onClick={() => setFeedbackOpen(true)}
          aria-label="Send feedback"
        >
          <MessageSquarePlus size={12} />
        </button>
        <button
          className={styles.logoButton}
          onClick={() => {
            setAboutMounted(true);
            setAboutOpen(true);
          }}
          aria-label="About Manor"
        >
          <ManorLogo />
        </button>
      </div>
      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      {aboutMounted && (
        <Suspense fallback={null}>
          <AboutModal open={aboutOpen} onOpenChange={setAboutOpen} />
        </Suspense>
      )}
    </div>
  );
}
