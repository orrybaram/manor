import { useState, useCallback, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useQueries } from "@tanstack/react-query";
import Unlink from "lucide-react/dist/esm/icons/unlink";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import type { LinkedIssue } from "../../../electron.d";
import type { CommandPaletteProps } from "../../command-palette/types";
import { LinearIcon } from "../../command-palette/LinearIcon";
import { GitHubIcon } from "../../command-palette/GitHubIcon";
import { TaskDetail } from "../../tasks/TaskDetail/TaskDetail";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { TRACKERS, type TaskTracker } from "../../../lib/trackers";
import type { TaskDetail as TaskDetailData, TaskRef } from "../../../lib/tasks";
import { addErrorToast } from "../../../store/toast-store";
import tasksStyles from "../../tasks/TasksView.module.css";
import styles from "./LinkedIssuesPopover.module.css";

function isGitHubIssue(issue: LinkedIssue): boolean {
  return issue.id.startsWith("gh-");
}

/** The tracker that owns a workspace link. */
function trackerOfLink(issue: LinkedIssue): TaskTracker | undefined {
  return Object.values(TRACKERS).find((t) => t.ownsLink(issue));
}

/** The ref to fetch and act on a link through, on the workspace's project. */
function refOfLink(
  issue: LinkedIssue,
  project: ProjectInfo | undefined,
): TaskRef | null {
  const tracker = trackerOfLink(issue);
  return tracker && project ? tracker.refFromLink(issue, project) : null;
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

type LinkedIssuesPopoverProps = {
  issues: LinkedIssue[];
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  workspacePath: string;
  onNewWorkspace: CommandPaletteProps["onNewWorkspace"];
  children: React.ReactNode;
};

type IssueRowSkeletonProps = {
  index: number;
};

function IssueRowSkeleton(props: IssueRowSkeletonProps) {
  const { index } = props;

  return (
    <div className={styles.skeletonRow}>
      <div className={`${styles.skeletonBone} ${styles.skeletonIdentifier}`} />
      <div
        className={`${styles.skeletonBone} ${styles.skeletonTitle}`}
        style={{ width: `${40 + ((index * 17) % 40)}%` }}
      />
      <div className={`${styles.skeletonBone} ${styles.skeletonState}`} />
    </div>
  );
}

type IssueRowProps = {
  issue: LinkedIssue;
  detail: TaskDetailData | undefined;
  isLoading: boolean;
  onClick: () => void;
  onUnlink: () => void;
  onCloseTicket: () => void;
};

function IssueRow(props: IssueRowProps) {
  const { issue, detail, isLoading, onClick, onUnlink, onCloseTicket } = props;

  const assigneeName = detail?.assignees[0];

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button className={styles.issueRow} onClick={onClick}>
          <span className={styles.issueIdentifier}>{issue.identifier}</span>
          <span className={styles.issueTitle}>{issue.title}</span>
          {isLoading ? (
            <span
              className={`${styles.skeletonBone} ${styles.skeletonState}`}
            />
          ) : detail ? (
            <>
              <span
                className={`${styles.issueStatus} ${tasksStyles[`tone-${detail.status.tone}`]}`}
              >
                {detail.status.label}
              </span>
              {assigneeName && (
                <span className={styles.issueAssignee}>
                  {assigneeName}
                </span>
              )}
            </>
          ) : null}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={onUnlink}
          >
            <Unlink size={12} />
            Unlink task
          </ContextMenu.Item>
          <ContextMenu.Item
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onSelect={onCloseTicket}
          >
            <CircleX size={12} />
            Close &amp; unlink
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function LinkedIssuesPopover(props: LinkedIssuesPopoverProps) {
  const { issues, isOpen, onClose, projectId, workspacePath, onNewWorkspace, children } = props;

  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const projects = useProjectStore((s) => s.projects);

  // Look up project and workspace info
  const project = projects.find((p) => p.id === projectId);
  const workspace = project?.workspaces.find((w) => w.path === workspacePath);
  const workspaceLabel = workspace?.name ?? workspace?.branch ?? "";

  // Track popover open/close — but do NOT reset selectedIssueId here,
  // because the popover closes when the dialog opens (focus steal).
  // selectedIssueId is only cleared when the dialog itself closes.

  // Each link's ref, through the tracker that owns it (ADR-208 §6).
  const refs = useMemo(
    () => new Map(issues.map((i) => [i.id, refOfLink(i, project)])),
    [issues, project],
  );

  // Live status for the list, from the same cache `TaskDetail` reads.
  const queried = issues.filter((i) => refs.get(i.id));
  const detailQueries = useQueries({
    queries: queried.map((issue) => {
      const ref = refs.get(issue.id) as TaskRef;
      return {
        ...TRACKERS[ref.provider].detailQuery(ref),
        retry: false,
        enabled: isOpen && issues.length > 1,
      };
    }),
  });
  const details: Record<string, TaskDetailData | undefined> = {};
  const loadingIds = new Set<string>();
  queried.forEach((issue, i) => {
    details[issue.id] = detailQueries[i]?.data;
    if (detailQueries[i]?.isLoading) loadingIds.add(issue.id);
  });

  const visibleIssues = issues.filter((i) => !removedIds.has(i.id));

  // Undo an optimistic removal — used when the mutation it was standing in
  // for turns out to have failed.
  const revertRemoval = useCallback((issueId: string) => {
    setRemovedIds((prev) => {
      const next = new Set(prev);
      next.delete(issueId);
      return next;
    });
  }, []);

  const handleUnlink = useCallback(
    async (issueId: string) => {
      const ref = refs.get(issueId);
      const unlink = ref && TRACKERS[ref.provider].unlink;
      if (!ref || !unlink) return;
      setRemovedIds((prev) => new Set(prev).add(issueId));
      // If that was the last visible issue, close the popover
      const remaining = visibleIssues.filter((i) => i.id !== issueId);
      if (remaining.length === 0) {
        onClose();
      }
      try {
        await unlink(ref, projectId, workspacePath);
      } catch (err) {
        // Revert the optimistic removal — the link still exists on disk.
        revertRemoval(issueId);
        addErrorToast(`unlink-issue-error-${issueId}`, "Failed to unlink task", err);
      }
    },
    [refs, projectId, workspacePath, visibleIssues, onClose, revertRemoval],
  );

  const handleCloseTicket = useCallback(
    async (issueId: string) => {
      const ref = refs.get(issueId);
      const tracker = ref && TRACKERS[ref.provider];
      if (!ref || !tracker?.close || !tracker.unlink) return;
      setRemovedIds((prev) => new Set(prev).add(issueId));
      const remaining = visibleIssues.filter((i) => i.id !== issueId);
      if (remaining.length === 0) {
        onClose();
      }
      try {
        await tracker.close(ref);
      } catch (err) {
        // Revert the optimistic removal — the issue is still open.
        revertRemoval(issueId);
        addErrorToast(`close-issue-error-${issueId}`, "Failed to close task", err);
        return;
      }
      try {
        await tracker.unlink(ref, projectId, workspacePath);
      } catch (err) {
        // The issue genuinely is closed now — do not revert the removal,
        // just surface that the workspace link is stale.
        addErrorToast(
          `unlink-after-close-error-${issueId}`,
          "Task closed, but failed to unlink from workspace",
          err,
        );
      }
    },
    [refs, projectId, workspacePath, visibleIssues, onClose, revertRemoval],
  );

  const handleRowClick = useCallback((issueId: string) => {
    setSelectedIssueId(issueId);
    onClose(); // close popover, dialog takes over
  }, [onClose]);

  // With a single linked issue, skip the list and open its detail directly.
  const singleIssueId =
    visibleIssues.length === 1 ? visibleIssues[0].id : null;
  const popoverOpen = isOpen && singleIssueId === null;
  const dialogIssueId =
    selectedIssueId ?? (isOpen ? singleIssueId : null);

  const handleDialogClose = useCallback(() => {
    setSelectedIssueId(null);
    onClose();
  }, [onClose]);

  const handleCloseAll = useCallback(() => {
    setSelectedIssueId(null);
    onClose();
  }, [onClose]);

  const dialogRef = dialogIssueId ? refs.get(dialogIssueId) : undefined;

  return (
    <>
      <Popover.Root open={popoverOpen} onOpenChange={(open) => !open && onClose()}>
        <Popover.Trigger asChild>{children}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={styles.popover}
            side="top"
            sideOffset={6}
            align="start"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <div className={styles.listHeader}>
              <LinkedIssueIcon issues={visibleIssues} size={10} />
              <span>Linked Tasks</span>
            </div>
            <div className={styles.listScroll}>
              {visibleIssues.map((issue, i) =>
                loadingIds.has(issue.id) ? (
                  <IssueRowSkeleton key={issue.id} index={i} />
                ) : (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    detail={details[issue.id]}
                    isLoading={false}
                    onClick={() => handleRowClick(issue.id)}
                    onUnlink={() => handleUnlink(issue.id)}
                    onCloseTicket={() => handleCloseTicket(issue.id)}
                  />
                ),
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Dialog.Root
        open={dialogIssueId !== null}
        onOpenChange={(open) => !open && handleDialogClose()}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.dialogOverlay} />
          <Dialog.Content className={styles.dialog}>
            <Dialog.Title className={styles.dialogSrOnly}>
              Task Detail
            </Dialog.Title>
            {dialogRef && (
              <TaskDetail
                key={dialogRef.id}
                taskRef={dialogRef}
                mode="linked"
                layout="card"
                linkedTo={workspaceLabel}
                projectId={projectId}
                workspacePath={workspacePath}
                onNewWorkspace={onNewWorkspace}
                onDone={handleCloseAll}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
