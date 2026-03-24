import { useCallback, useRef } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useProjectStore } from "../../store/project-store";
import { stripMarkdown } from "./utils";
import { IssueDetailSkeleton } from "./IssueDetailSkeleton";
import type { CommandPaletteProps } from "./types";
import styles from "./CommandPalette.module.css";

interface GitHubIssueDetailViewProps {
  repoPath: string;
  issueNumber: number;
  onBack: () => void;
  onClose: () => void;
  onNewWorkspace: CommandPaletteProps["onNewWorkspace"];
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function GitHubIssueDetailView({
  repoPath,
  issueNumber,
  onBack,
  onClose,
  onNewWorkspace,
}: GitHubIssueDetailViewProps) {
  const projects = useProjectStore((s) => s.projects);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  const { data: issueDetail, isLoading } = useQuery({
    queryKey: ["github-issue-detail", repoPath, issueNumber],
    queryFn: () => window.electronAPI.github.getIssueDetail(repoPath, issueNumber),
    staleTime: 60_000,
  });

  const findProject = useCallback(() => {
    return projects.find((p) => p.path === repoPath);
  }, [projects, repoPath]);

  const handleCreateWorkspace = useCallback(() => {
    if (!issueDetail) return;
    const project = findProject();
    if (!project) return;

    const branchName = `${issueDetail.number}-${slugify(issueDetail.title)}`;

    const current = useProjectStore
      .getState()
      .projects.find((p) => p.id === project.id);
    const existingIdx =
      current?.workspaces.findIndex((ws) => ws.branch === branchName) ?? -1;
    if (existingIdx >= 0) {
      selectWorkspace(project.id, existingIdx);
      onClose();
      return;
    }

    onClose();
    onNewWorkspace?.({
      projectId: project.id,
      name: issueDetail.title,
      branch: branchName,
      agentPrompt: issueDetail.title + "\n\n" + (issueDetail.body ?? ""),
    });
    window.electronAPI.github.assignIssue(repoPath, issueDetail.number);
  }, [issueDetail, findProject, selectWorkspace, onClose, onNewWorkspace]);

  const handleOpenInBrowser = useCallback(() => {
    if (!issueDetail) return;
    window.electronAPI.shell.openExternal(issueDetail.url);
    onClose();
  }, [issueDetail, onClose]);

  const handleCreateWorkspaceRef = useRef(handleCreateWorkspace);
  handleCreateWorkspaceRef.current = handleCreateWorkspace;
  const handleOpenInBrowserRef = useRef(handleOpenInBrowser);
  handleOpenInBrowserRef.current = handleOpenInBrowser;

  useMountEffect(() => {
    let ready = false;
    const rafId = requestAnimationFrame(() => {
      ready = true;
    });
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (!ready) return;
      if (e.key === "Enter") {
        e.preventDefault();
        handleCreateWorkspaceRef.current();
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "o" && e.metaKey) {
        e.preventDefault();
        handleOpenInBrowserRef.current();
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

  const description = issueDetail.body
    ? stripMarkdown(issueDetail.body)
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
            <span className={styles.sidebarLabel}>State</span>
            <span className={styles.sidebarValue}>
              <span className={styles.statusDot} />
              {issueDetail.state}
            </span>
          </div>
          <div className={styles.sidebarField}>
            <span className={styles.sidebarLabel}>Labels</span>
            {issueDetail.labels.length > 0 ? (
              <div className={styles.sidebarLabels}>
                {issueDetail.labels.map((label) => (
                  <span
                    key={label.name}
                    className={styles.detailLabel}
                    style={{
                      background: `#${label.color}22`,
                      color: `#${label.color}`,
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
          {issueDetail.assignees.length > 0 && (
            <div className={styles.sidebarField}>
              <span className={styles.sidebarLabel}>Assignees</span>
              <span className={styles.sidebarValue}>
                {issueDetail.assignees.map((a) => a.login).join(", ")}
              </span>
            </div>
          )}
          {issueDetail.milestone && (
            <div className={styles.sidebarField}>
              <span className={styles.sidebarLabel}>Milestone</span>
              <span className={styles.sidebarValue}>
                {issueDetail.milestone.title}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className={styles.detailFooter}>
        <span className={styles.footerHint}>
          <kbd className={styles.kbd}>Enter</kbd>
          <span>Start Work</span>
        </span>
        <span className={styles.footerHint}>
          <kbd className={styles.kbd}>&#8984;O</kbd>
          <span>Open in Browser</span>
        </span>
      </div>
    </>
  );
}
