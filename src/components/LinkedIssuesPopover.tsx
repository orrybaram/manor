import { useState, useRef, useCallback } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useQuery } from "@tanstack/react-query";
import { Unlink } from "lucide-react";
import type { LinkedIssue, LinearIssueDetail, GitHubIssueDetail } from "../electron.d";
import type { CommandPaletteProps } from "./CommandPalette/types";
import { IssueDetailView } from "./CommandPalette/IssueDetailView";
import { GitHubIssueDetailView } from "./CommandPalette/GitHubIssueDetailView";
import { LinearIcon } from "./CommandPalette/LinearIcon";
import { GitHubIcon } from "./CommandPalette/GitHubIcon";
import { useProjectStore } from "../store/project-store";
import { useToastStore } from "../store/toast-store";
import styles from "./LinkedIssuesPopover.module.css";

type IssueDetail =
  | { source: "linear"; data: LinearIssueDetail }
  | { source: "github"; data: GitHubIssueDetail };

function isGitHubIssue(issue: LinkedIssue): boolean {
  return issue.id.startsWith("gh-");
}

function LinkedIssueIcon({ issues, size }: { issues: LinkedIssue[]; size: number }) {
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

interface LinkedIssuesPopoverProps {
  issues: LinkedIssue[];
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  workspacePath: string;
  onNewWorkspace: CommandPaletteProps["onNewWorkspace"];
  onNewTaskWithPrompt?: (prompt: string) => void;
  children: React.ReactNode;
}

function IssueRowSkeleton({ index }: { index: number }) {
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

function getStatusStyle(detail: IssueDetail | undefined): {
  color: string;
  background: string;
} {
  if (detail?.source === "linear") {
    switch (detail.data.state.type) {
      case "started":
        return { color: "var(--yellow)", background: "var(--yellow-a20, rgba(249,226,175,0.13))" };
      case "completed":
        return { color: "var(--green)", background: "var(--green-a20, rgba(166,227,161,0.13))" };
      case "cancelled":
        return { color: "var(--red)", background: "var(--red-a20, rgba(238,85,85,0.13))" };
      default:
        return { color: "var(--text-dim)", background: "var(--surface)" };
    }
  }
  if (detail?.source === "github") {
    switch (detail.data.state) {
      case "open":
        return { color: "var(--green)", background: "var(--green-a20, rgba(166,227,161,0.13))" };
      case "closed":
        return { color: "var(--red)", background: "var(--red-a20, rgba(238,85,85,0.13))" };
      default:
        return { color: "var(--text-dim)", background: "var(--surface)" };
    }
  }
  return { color: "var(--text-dim)", background: "var(--surface)" };
}

function IssueRow({
  issue,
  detail,
  isLoading,
  onClick,
  onUnlink,
}: {
  issue: LinkedIssue;
  detail: IssueDetail | undefined;
  isLoading: boolean;
  onClick: () => void;
  onUnlink: () => void;
}) {
  const stateName =
    detail?.source === "linear"
      ? detail.data.state.name
      : detail?.source === "github"
        ? detail.data.state
        : undefined;

  const assigneeName =
    detail?.source === "linear"
      ? detail.data.assignee?.displayName
      : detail?.source === "github"
        ? detail.data.assignees[0]?.login
        : undefined;

  const statusStyle = getStatusStyle(detail);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button className={styles.issueRow} onClick={onClick}>
          <span className={styles.issueIdentifier}>{issue.identifier}</span>
          <span className={styles.issueTitle}>
            {detail?.data.title ?? issue.title}
          </span>
          {isLoading ? (
            <span
              className={`${styles.skeletonBone} ${styles.skeletonState}`}
            />
          ) : detail ? (
            <>
              <span className={styles.issueStatus} style={statusStyle}>{stateName}</span>
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
            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
            onSelect={onUnlink}
          >
            <Unlink size={12} />
            Unlink issue
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function LinkedIssuesPopover({
  issues,
  isOpen,
  onClose,
  projectId,
  workspacePath,
  onNewWorkspace,
  onNewTaskWithPrompt,
  children,
}: LinkedIssuesPopoverProps) {
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const projects = useProjectStore((s) => s.projects);

  // Look up project and workspace info
  const project = projects.find((p) => p.id === projectId);
  const repoPath = project?.path ?? "";
  const workspace = project?.workspaces.find((w) => w.path === workspacePath);
  const workspaceLabel = workspace?.name ?? workspace?.branch ?? "";

  // Track popover open/close — but do NOT reset selectedIssueId here,
  // because the popover closes when the dialog opens (focus steal).
  // selectedIssueId is only cleared when the dialog itself closes.

  // Fetch live details for all linked issues
  const issueIds = issues.map((i) => i.id);
  const { data: details, isLoading } = useQuery({
    queryKey: ["linked-issue-details", ...issueIds],
    queryFn: async () => {
      const results: Record<string, IssueDetail> = {};

      const githubIssues = issues.filter(isGitHubIssue);
      const linearIssues = issues.filter((i) => !isGitHubIssue(i));

      await Promise.all([
        // Fetch GitHub issue details
        ...githubIssues.map(async (issue) => {
          try {
            const number = parseInt(issue.id.replace("gh-", ""), 10);
            const detail = await window.electronAPI.github.getIssueDetail(
              repoPath,
              number,
            );
            results[issue.id] = { source: "github", data: detail };
          } catch {
            // GitHub uses gh CLI — no auth toast needed, just skip
          }
        }),
        // Fetch Linear issue details
        ...linearIssues.map(async (issue) => {
          try {
            const detail = await window.electronAPI.linear.getIssueDetail(
              issue.id,
            );
            results[issue.id] = { source: "linear", data: detail };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (
              message.includes("401") ||
              message.includes("token") ||
              message.includes("auth") ||
              message.includes("unauthorized")
            ) {
              useToastStore.getState().addToast({
                id: `linear-auth-error-${Date.now()}`,
                message: "Linear token expired",
                status: "error",
                detail:
                  "Update your Linear API key to see issue details.",
                action: {
                  label: "Open Settings",
                  onClick: () => {
                    onClose();
                  },
                },
              });
            }
            // Fall back to cached data — just skip this issue's detail
          }
        }),
      ]);
      return results;
    },
    enabled: isOpen && issues.length > 0,
    staleTime: 30_000,
  });

  const visibleIssues = issues.filter((i) => !removedIds.has(i.id));

  const handleUnlink = useCallback(
    async (issueId: string) => {
      setRemovedIds((prev) => new Set(prev).add(issueId));
      // If that was the last visible issue, close the popover
      const remaining = visibleIssues.filter((i) => i.id !== issueId);
      if (remaining.length === 0) {
        onClose();
      }
      await window.electronAPI.linear.unlinkIssueFromWorkspace(
        projectId,
        workspacePath,
        issueId,
      );
      useProjectStore.getState().loadProjects();
    },
    [projectId, workspacePath, visibleIssues, onClose],
  );

  const handleRowClick = useCallback((issueId: string) => {
    setSelectedIssueId(issueId);
    onClose(); // close popover, dialog takes over
  }, [onClose]);

  const handleDialogClose = useCallback(() => {
    setSelectedIssueId(null);
  }, []);

  const handleCloseAll = useCallback(() => {
    setSelectedIssueId(null);
    onClose();
  }, [onClose]);

  const selectedIsGitHub = selectedIssueId?.startsWith("gh-") ?? false;

  return (
    <>
      <Popover.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
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
              <span>Linked Issues</span>
            </div>
            <div className={styles.listScroll}>
              {visibleIssues.map((issue, i) =>
                isLoading && !details?.[issue.id] ? (
                  <IssueRowSkeleton key={issue.id} index={i} />
                ) : (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    detail={details?.[issue.id]}
                    isLoading={false}
                    onClick={() => handleRowClick(issue.id)}
                    onUnlink={() => handleUnlink(issue.id)}
                  />
                ),
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Dialog.Root
        open={selectedIssueId !== null}
        onOpenChange={(open) => !open && handleDialogClose()}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.dialogOverlay} />
          <Dialog.Content className={styles.dialog}>
            <Dialog.Title className={styles.dialogSrOnly}>
              Issue Detail
            </Dialog.Title>
            {selectedIssueId && (
              selectedIsGitHub ? (
                <GitHubIssueDetailView
                  repoPath={repoPath}
                  issueNumber={parseInt(
                    selectedIssueId.replace("gh-", ""),
                    10,
                  )}
                  onBack={handleDialogClose}
                  onClose={handleCloseAll}
                  onNewWorkspace={onNewWorkspace}
                  onNewTaskWithPrompt={onNewTaskWithPrompt}
                  linkedTo={workspaceLabel}
                />
              ) : (
                <IssueDetailView
                  issueId={selectedIssueId}
                  onBack={handleDialogClose}
                  onClose={handleCloseAll}
                  onNewWorkspace={onNewWorkspace}
                  onNewTaskWithPrompt={onNewTaskWithPrompt}
                  linkedTo={workspaceLabel}
                />
              )
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
