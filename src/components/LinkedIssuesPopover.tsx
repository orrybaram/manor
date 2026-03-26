import { useState, useRef, useCallback } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useQuery } from "@tanstack/react-query";
import { Unlink } from "lucide-react";
import type { LinkedIssue, LinearIssueDetail } from "../electron.d";
import type { CommandPaletteProps } from "./CommandPalette/types";
import { IssueDetailView } from "./CommandPalette/IssueDetailView";
import { LinearIcon } from "./CommandPalette/LinearIcon";
import { useToastStore } from "../store/toast-store";
import styles from "./LinkedIssuesPopover.module.css";

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

function IssueRow({
  issue,
  detail,
  isLoading,
  onClick,
  onUnlink,
}: {
  issue: LinkedIssue;
  detail: LinearIssueDetail | undefined;
  isLoading: boolean;
  onClick: () => void;
  onUnlink: () => void;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button className={styles.issueRow} onClick={onClick}>
          <span className={styles.issueIdentifier}>{issue.identifier}</span>
          <span className={styles.issueTitle}>
            {detail?.title ?? issue.title}
          </span>
          {isLoading ? (
            <span
              className={`${styles.skeletonBone} ${styles.skeletonState}`}
            />
          ) : detail ? (
            <>
              <span className={styles.issueStatus}>{detail.state.name}</span>
              {detail.assignee && (
                <span className={styles.issueAssignee}>
                  {detail.assignee.displayName}
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
  const [view, setView] = useState<"list" | "detail">("list");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  // Reset to list view when popover closes (synchronous during render)
  const prevOpenRef = useRef(isOpen);
  if (prevOpenRef.current && !isOpen) {
    setView("list");
    setSelectedIssueId(null);
  }
  prevOpenRef.current = isOpen;

  // Fetch live details for all linked issues
  const issueIds = issues.map((i) => i.id);
  const { data: details, isLoading } = useQuery({
    queryKey: ["linked-issue-details", ...issueIds],
    queryFn: async () => {
      const results: Record<string, LinearIssueDetail> = {};
      await Promise.all(
        issues.map(async (issue) => {
          try {
            const detail =
              await window.electronAPI.linear.getIssueDetail(issue.id);
            results[issue.id] = detail;
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
                    // The settings modal is controlled by App — dispatch via store or
                    // simply let the user click Settings from command palette.
                    // For now, we close the popover; the toast action is informational.
                    onClose();
                  },
                },
              });
            }
            // Fall back to cached data — just skip this issue's detail
          }
        }),
      );
      return results;
    },
    enabled: isOpen && issues.length > 0,
    staleTime: 30_000,
  });

  const handleUnlink = useCallback(
    async (issueId: string) => {
      await window.electronAPI.linear.unlinkIssueFromWorkspace(
        projectId,
        workspacePath,
        issueId,
      );
      // If that was the last issue, close the popover
      if (issues.length <= 1) {
        onClose();
      }
    },
    [projectId, workspacePath, issues.length, onClose],
  );

  const handleRowClick = useCallback((issueId: string) => {
    setSelectedIssueId(issueId);
    setView("detail");
  }, []);

  const handleBack = useCallback(() => {
    setView("list");
    setSelectedIssueId(null);
  }, []);

  return (
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
          {view === "list" ? (
            <>
              <div className={styles.listHeader}>
                <LinearIcon size={10} />
                <span>Linked Issues</span>
              </div>
              <div className={styles.listScroll}>
                {issues.map((issue, i) =>
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
            </>
          ) : selectedIssueId ? (
            <div className={styles.detailView}>
              <div className={styles.detailContent}>
                <IssueDetailView
                  issueId={selectedIssueId}
                  onBack={handleBack}
                  onClose={onClose}
                  onNewWorkspace={onNewWorkspace}
                  onNewTaskWithPrompt={onNewTaskWithPrompt}
                />
              </div>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
