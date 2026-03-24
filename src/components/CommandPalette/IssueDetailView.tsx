import { useCallback, useRef } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import type { LinearIssue } from "../../electron.d";
import { PRIORITY_LABELS, stripMarkdown } from "./utils";
import { IssueDetailSkeleton } from "./IssueDetailSkeleton";
import type { CommandPaletteProps } from "./types";
import styles from "./CommandPalette.module.css";

interface IssueDetailViewProps {
  issueId: string;
  onBack: () => void;
  onClose: () => void;
  onNewWorkspace: CommandPaletteProps["onNewWorkspace"];
  onNewTaskWithPrompt?: (prompt: string) => void;
}

export function IssueDetailView({
  issueId,
  onBack,
  onClose,
  onNewWorkspace,
  onNewTaskWithPrompt,
}: IssueDetailViewProps) {
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const projects = useProjectStore((s) => s.projects);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  const { data: issueDetail, isLoading } = useQuery({
    queryKey: ["linear-issue-detail", issueId],
    queryFn: () => window.electronAPI.linear.getIssueDetail(issueId),
    staleTime: 60_000,
  });

  const findProjectForIssue = useCallback(
    (_issue: LinearIssue) => {
      return projects.find((p) => p.linearAssociations.length > 0);
    },
    [projects],
  );

  const handleCreateWorkspace = useCallback(
    (issue: LinearIssue) => {
      const project = findProjectForIssue(issue);
      if (!project) return;

      const current = useProjectStore
        .getState()
        .projects.find((p) => p.id === project.id);
      const existingIdx =
        current?.workspaces.findIndex(
          (ws) => ws.branch === issue.branchName,
        ) ?? -1;
      if (existingIdx >= 0) {
        selectWorkspace(project.id, existingIdx);
        const existingWs = current?.workspaces[existingIdx];
        if (existingWs) setActiveWorkspace(existingWs.path);
        onClose();
        return;
      }

      onClose();
      onNewWorkspace?.({
        projectId: project.id,
        name: issue.title,
        branch: issue.branchName,
        agentPrompt: issue.title + "\n\n" + (issueDetailRef.current?.description ?? ""),
      });
      window.electronAPI.linear.startIssue(issue.id);
    },
    [
      findProjectForIssue,
      selectWorkspace,
      setActiveWorkspace,
      onClose,
      onNewWorkspace,
    ],
  );

  const handleOpenInBrowser = useCallback(
    (issue: LinearIssue) => {
      window.electronAPI.shell.openExternal(issue.url);
      onClose();
    },
    [onClose],
  );

  const handleNewTask = useCallback(
    (issue: LinearIssue) => {
      const prompt = issue.title + "\n\n" + (issueDetailRef.current?.description ?? "");
      onNewTaskWithPrompt?.(prompt);
      window.electronAPI.linear.startIssue(issue.id);
      onClose();
    },
    [onNewTaskWithPrompt, onClose],
  );

  // Keyboard shortcuts — refs hold latest values so the mount effect never re-subscribes.
  const issueDetailRef = useRef(issueDetail);
  issueDetailRef.current = issueDetail;
  const handleCreateWorkspaceRef = useRef(handleCreateWorkspace);
  handleCreateWorkspaceRef.current = handleCreateWorkspace;
  const handleOpenInBrowserRef = useRef(handleOpenInBrowser);
  handleOpenInBrowserRef.current = handleOpenInBrowser;
  const handleNewTaskRef = useRef(handleNewTask);
  handleNewTaskRef.current = handleNewTask;

  // The Enter keyup from the list selection can arrive after this effect
  // registers its listener, so we gate on a `ready` flag set after a frame.
  useMountEffect(() => {
    let ready = false;
    const rafId = requestAnimationFrame(() => {
      ready = true;
    });
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (!ready || !issueDetailRef.current) return;
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        handleNewTaskRef.current(issueDetailRef.current);
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleCreateWorkspaceRef.current(issueDetailRef.current);
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!issueDetailRef.current) return;
      if (e.key === "o" && e.metaKey) {
        e.preventDefault();
        handleOpenInBrowserRef.current(issueDetailRef.current);
      }
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  if (isLoading) {
    return <IssueDetailSkeleton onBack={onBack} />;
  }

  if (!issueDetail) return null;

  const priority = PRIORITY_LABELS[issueDetail.priority] ?? PRIORITY_LABELS[0];
  const description = issueDetail.description
    ? stripMarkdown(issueDetail.description)
    : null;

  return (
    <>
      <div className={styles.detailLayout}>
        <div className={styles.detailBack}>
          <button className={styles.breadcrumbBack} onClick={onBack}>
            <ArrowLeft size={14} />
          </button>
        </div>
        <div className={styles.detailMain}>
          <h2 className={styles.detailTitle}>{issueDetail.title}</h2>
          {description && (
            <div className={styles.detailDescription}>{description}</div>
          )}
        </div>
        <div className={styles.detailSidebar}>
          <div className={styles.sidebarField}>
            <span className={styles.sidebarLabel}>Status</span>
            <span className={styles.sidebarValue}>
              <span className={styles.statusDot} />
              {issueDetail.state.name}
            </span>
          </div>
          <div className={styles.sidebarField}>
            <span className={styles.sidebarLabel}>Priority</span>
            <span className={styles.sidebarValue}>
              <span
                className={styles.priorityDot}
                style={{ background: priority.color }}
              />
              {priority.label}
            </span>
          </div>
          {issueDetail.assignee && (
            <div className={styles.sidebarField}>
              <span className={styles.sidebarLabel}>Assignee</span>
              <span className={styles.sidebarValue}>
                {issueDetail.assignee.displayName}
              </span>
            </div>
          )}
          <div className={styles.sidebarField}>
            <span className={styles.sidebarLabel}>Labels</span>
            {issueDetail.labels.length > 0 ? (
              <div className={styles.sidebarLabels}>
                {issueDetail.labels.map((label) => (
                  <span
                    key={label.id}
                    className={styles.detailLabel}
                    style={{
                      background: label.color + "22",
                      color: label.color,
                    }}
                  >
                    {label.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className={styles.sidebarValue}>No Labels</span>
            )}
          </div>
        </div>
      </div>
      <div className={styles.detailFooter}>
        <span className={styles.footerHint}>
          <kbd className={styles.kbd}>Enter</kbd>
          <span>Start Work</span>
        </span>
        <span className={styles.footerHint}>
          <kbd className={styles.kbd}>Shift+Enter</kbd>
          <span>New Task</span>
        </span>
        <span className={styles.footerHint}>
          <kbd className={styles.kbd}>&#8984;O</kbd>
          <span>Open in Browser</span>
        </span>
      </div>
    </>
  );
}
