import { useCallback, useRef } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useQuery } from "@tanstack/react-query";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { addErrorToast } from "../../store/toast-store";
import { stripMarkdown } from "./utils";
import { IssueDetailSkeleton } from "./IssueDetailSkeleton";
import type { CommandPaletteProps } from "./types";
import { Row, Stack } from "../ui/Layout/Layout";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { assignIssueBestEffort, startGitHubIssueWork } from "../../lib/start-issue-work";
import type { GhRepo } from "../../lib/gh-repo";
import styles from "./CommandPalette.module.css";

type GitHubIssueDetailViewProps = {
  /** The project's checkout, on its host (ADR-191). */
  repo: GhRepo;
  issueNumber: number;
  /** When known, looked up by URL so an issue from another repo still resolves. */
  issueUrl?: string;
  onBack: () => void;
  onClose: () => void;
  onNewWorkspace: CommandPaletteProps["onNewWorkspace"];
  onNewAgentWithPrompt?: (prompt: string) => void;
  linkedTo?: string;
  projectId?: string;
  workspacePath?: string;
};

export function GitHubIssueDetailView(props: GitHubIssueDetailViewProps) {
  const { repo, issueNumber, issueUrl, onBack, onClose, onNewWorkspace, onNewAgentWithPrompt, linkedTo, projectId, workspacePath } = props;

  const projects = useProjectStore((s) => s.projects);

  const { data: issueDetail, isLoading, error, refetch } = useQuery({
    queryKey: ["github-issue-detail", repo.hostId, repo.path, issueNumber, issueUrl],
    queryFn: () =>
      window.electronAPI.github.getIssueDetail(repo, issueNumber, issueUrl),
    staleTime: 60_000,
    // `gh` failures (wrong repo, not found, auth) are deterministic, and each
    // attempt can take up to its 10s timeout — the default three retries with
    // backoff left the skeleton up for most of a minute before going blank.
    retry: false,
  });

  const findProject = useCallback(() => {
    return projects.find((p) => p.path === repo.path && p.hostId === repo.hostId);
  }, [projects, repo]);

  const handleCreateWorkspace = useCallback(() => {
    if (!issueDetail) return;
    const project = findProject();
    if (!project) return;
    startGitHubIssueWork({ project, repo, issue: issueDetail, onNewWorkspace, onClose });
  }, [issueDetail, findProject, onClose, onNewWorkspace, repo]);

  const handleOpenInBrowser = useCallback(() => {
    if (!issueDetail) return;
    window.electronAPI.shell.openExternal(issueDetail.url);
    onClose();
  }, [issueDetail, onClose]);

  const handleNewAgent = useCallback(() => {
    if (!issueDetail) return;
    const prompt = issueDetail.title + "\n\n" + (issueDetail.body ?? "");
    onNewAgentWithPrompt?.(prompt);
    assignIssueBestEffort(repo, issueDetail.number);
    onClose();

    const activeWorkspacePath = useAppStore.getState().activeWorkspacePath;
    const allProjects = useProjectStore.getState().projects;
    const project = allProjects.find((p) =>
      p.workspaces.some((w) => w.path === activeWorkspacePath),
    );
    if (project && activeWorkspacePath) {
      useProjectStore.getState().linkIssueToWorkspace(
        project.id,
        activeWorkspacePath,
        {
          id: `gh-${issueDetail.number}`,
          identifier: `#${issueDetail.number}`,
          title: issueDetail.title,
          url: issueDetail.url,
        },
      );
    }
  }, [issueDetail, onNewAgentWithPrompt, repo, onClose]);

  const handleUnlink = useCallback(async () => {
    if (!projectId || !workspacePath) return;
    try {
      await window.electronAPI.linear.unlinkIssueFromWorkspace(
        projectId,
        workspacePath,
        `gh-${issueNumber}`,
      );
    } catch (err) {
      addErrorToast(
        `unlink-issue-error-gh-${issueNumber}`,
        "Failed to unlink issue",
        err,
      );
      return;
    }
    onClose();
    useProjectStore.getState().loadProjects();
  }, [projectId, workspacePath, issueNumber, onClose]);

  const handleCloseTicket = useCallback(async () => {
    if (!projectId || !workspacePath) return;
    try {
      await window.electronAPI.github.closeIssue(repo, issueNumber);
    } catch (err) {
      addErrorToast(
        `close-issue-error-gh-${issueNumber}`,
        "Failed to close issue",
        err,
      );
      return;
    }
    onClose();
    try {
      await window.electronAPI.linear.unlinkIssueFromWorkspace(
        projectId,
        workspacePath,
        `gh-${issueNumber}`,
      );
    } catch (err) {
      // The issue genuinely is closed now — surface the stale link without
      // undoing the close.
      addErrorToast(
        `unlink-after-close-error-gh-${issueNumber}`,
        "Issue closed, but failed to unlink from workspace",
        err,
      );
      return;
    }
    useProjectStore.getState().loadProjects();
  }, [projectId, workspacePath, repo, issueNumber, onClose]);

  const handleCreateWorkspaceRef = useRef(handleCreateWorkspace);
  handleCreateWorkspaceRef.current = handleCreateWorkspace;
  const handleOpenInBrowserRef = useRef(handleOpenInBrowser);
  handleOpenInBrowserRef.current = handleOpenInBrowser;
  const handleNewAgentRef = useRef(handleNewAgent);
  handleNewAgentRef.current = handleNewAgent;

  useMountEffect(() => {
    let ready = false;
    const rafId = requestAnimationFrame(() => {
      ready = true;
    });
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (!ready || linkedTo) return;
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        handleCreateWorkspaceRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleNewAgentRef.current();
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

  if (!issueDetail) {
    return (
      <GitHubIssueDetailError
        issueNumber={issueNumber}
        issueUrl={issueUrl}
        error={error}
        onBack={onBack}
        onRetry={() => refetch()}
      />
    );
  }

  const description = issueDetail.body ? stripMarkdown(issueDetail.body) : null;

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
          <Stack gap="xs">
            <span className={styles.sidebarLabel}>State</span>
            <Row align="center" gap="xxs" className={styles.sidebarValue}>
              <span className={styles.statusDot} />
              {issueDetail.state}
            </Row>
          </Stack>
          <Stack gap="xs">
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
              <Row align="center" gap="xxs" className={styles.sidebarValue}>No Labels</Row>
            )}
          </Stack>
          {issueDetail.assignees.length > 0 && (
            <Stack gap="xs">
              <span className={styles.sidebarLabel}>Assignees</span>
              <Row align="center" gap="xxs" className={styles.sidebarValue}>
                {issueDetail.assignees.map((a) => a.login).join(", ")}
              </Row>
            </Stack>
          )}
          {issueDetail.milestone && (
            <Stack gap="xs">
              <span className={styles.sidebarLabel}>Milestone</span>
              <Row align="center" gap="xxs" className={styles.sidebarValue}>
                {issueDetail.milestone.title}
              </Row>
            </Stack>
          )}
        </div>
      </div>
      <div className={styles.detailFooter}>
        {linkedTo ? (
          <>
            <span className={styles.footerLinked}>
              Linked to <strong>{linkedTo}</strong>
            </span>
            <button
              className={styles.footerHint}
              onClick={handleUnlink}
            >
              <span>Unlink</span>
            </button>
            <button
              className={`${styles.footerHint} ${styles.footerHintDanger}`}
              onClick={handleCloseTicket}
            >
              <span>Close &amp; Unlink</span>
            </button>
          </>
        ) : (
          <>
            <button className={styles.footerHint} onClick={handleNewAgent}>
              <kbd className={styles.kbd}>Enter</kbd>
              <span>New Agent</span>
            </button>
            <button className={styles.footerHint} onClick={handleCreateWorkspace}>
              <kbd className={styles.kbd}>Shift+Enter</kbd>
              <span>Create Workspace</span>
            </button>
          </>
        )}
        <button className={styles.footerHint} onClick={handleOpenInBrowser}>
          <kbd className={styles.kbd}>&#8984;O</kbd>
          <span>Open in Browser</span>
        </button>
      </div>
    </>
  );
}

type GitHubIssueDetailErrorProps = {
  issueNumber: number;
  issueUrl?: string;
  error: unknown;
  onBack: () => void;
  onRetry: () => void;
};

function GitHubIssueDetailError(props: GitHubIssueDetailErrorProps) {
  const { issueNumber, issueUrl, error, onBack, onRetry } = props;

  const message = error instanceof Error ? error.message : error ? String(error) : null;

  return (
    <div className={styles.detailLayout}>
      <div className={styles.detailBack}>
        <button className={styles.breadcrumbBack} onClick={onBack}>
          <ArrowLeft size={14} />
        </button>
      </div>
      <div className={styles.detailMain}>
        <Stack gap="sm">
          <h2 className={styles.detailTitle}>Couldn't load issue #{issueNumber}</h2>
          {message && (
            <div className={styles.detailDescription}>{message}</div>
          )}
          <Row gap="sm" align="center">
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
            {issueUrl && <Link href={issueUrl}>Open on GitHub</Link>}
          </Row>
        </Stack>
      </div>
    </div>
  );
}
