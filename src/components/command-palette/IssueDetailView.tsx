import { useCallback, useEffect, useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useQuery } from "@tanstack/react-query";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import { selectActiveWorkspaceKey, useAppStore } from "../../store/app-store";
import { ownerOf } from "../../lib/workspace-directory";
import { useProjectStore } from "../../store/project-store";
import type { LinearIssue, LinearIssueDetail } from "../../electron.d";
import { PRIORITY_LABELS, stripMarkdown, extractImages } from "./utils";
import { IssueDetailSkeleton } from "./IssueDetailSkeleton";
import type { CommandPaletteProps } from "./types";
import { Row, Stack } from "../ui/Layout/Layout";
import { startLinearIssueWork } from "../../lib/start-issue-work";
import { isHomePath } from "../../lib/home-path";
import styles from "./CommandPalette.module.css";

type IssueDetailViewProps = {
  issueId: string;
  onBack: () => void;
  onClose: () => void;
  onNewWorkspace: CommandPaletteProps["onNewWorkspace"];
  onNewAgentWithPrompt?: (prompt: string) => void;
  linkedTo?: string;
  projectId?: string;
  workspacePath?: string;
};

export function IssueDetailView(props: IssueDetailViewProps) {
  const { issueId, onBack, onClose, onNewWorkspace, onNewAgentWithPrompt, linkedTo, projectId, workspacePath } = props;

  const projects = useProjectStore((s) => s.projects);
  // The Dashboard has no tabs to host a new agent (ADR-197); "Create
  // Workspace" stays available.
  const canNewAgent = useAppStore((s) => !isHomePath(s.activeWorkspacePath));

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
    (issue: LinearIssueDetail) => {
      const project = findProjectForIssue(issue);
      if (!project) return;
      startLinearIssueWork({ project, issue, onNewWorkspace, onClose });
    },
    [findProjectForIssue, onClose, onNewWorkspace],
  );

  const handleOpenInBrowser = useCallback(
    (issue: LinearIssue) => {
      window.electronAPI.shell.openExternal(issue.url);
      onClose();
    },
    [onClose],
  );

  const handleNewAgent = useCallback(
    (issue: LinearIssueDetail) => {
      const prompt =
        issue.title + "\n\n" + (issue.description ?? "");
      onNewAgentWithPrompt?.(prompt);
      window.electronAPI.linear.startIssue(issue.id);
      onClose();

      const state = useAppStore.getState();
      const activeWorkspacePath = state.activeWorkspacePath;
      const activeKey = selectActiveWorkspaceKey(state);
      const project = ownerOf(useProjectStore.getState().projects, activeKey);
      if (project && activeWorkspacePath) {
        useProjectStore.getState().linkIssueToWorkspace(
          project.id,
          activeWorkspacePath,
          {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
          },
        );
      }
    },
    [onNewAgentWithPrompt, onClose],
  );

  const handleUnlink = useCallback(async () => {
    if (!projectId || !workspacePath) return;
    onClose();
    await window.electronAPI.linear.unlinkIssueFromWorkspace(
      projectId,
      workspacePath,
      issueId,
    );
    useProjectStore.getState().loadProjects();
  }, [projectId, workspacePath, issueId, onClose]);

  const handleCloseTicket = useCallback(async () => {
    if (!projectId || !workspacePath) return;
    onClose();
    await window.electronAPI.linear.closeIssue(issueId);
    await window.electronAPI.linear.unlinkIssueFromWorkspace(
      projectId,
      workspacePath,
      issueId,
    );
    useProjectStore.getState().loadProjects();
  }, [projectId, workspacePath, issueId, onClose]);

  // Keyboard shortcuts — refs hold latest values so the mount effect never re-subscribes.
  const issueDetailRef = useRef(issueDetail);
  const handleCreateWorkspaceRef = useRef(handleCreateWorkspace);
  const handleOpenInBrowserRef = useRef(handleOpenInBrowser);
  const canNewAgentRef = useRef(canNewAgent);
  const handleNewAgentRef = useRef(handleNewAgent);
  issueDetailRef.current = issueDetail;
  handleCreateWorkspaceRef.current = handleCreateWorkspace;
  handleOpenInBrowserRef.current = handleOpenInBrowser;
  handleNewAgentRef.current = handleNewAgent;
  canNewAgentRef.current = canNewAgent;

  // The Enter keyup from the list selection can arrive after this effect
  // registers its listener, so we gate on a `ready` flag set after a frame.
  useMountEffect(() => {
    let ready = false;
    const rafId = requestAnimationFrame(() => {
      ready = true;
    });
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (!ready || !issueDetailRef.current || linkedTo) return;
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        handleCreateWorkspaceRef.current(issueDetailRef.current);
      } else if (e.key === "Enter" && canNewAgentRef.current) {
        e.preventDefault();
        handleNewAgentRef.current(issueDetailRef.current);
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
  const images = issueDetail.description
    ? extractImages(issueDetail.description)
    : [];

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
          {images.length > 0 && (
            <div className={styles.detailScreenshots}>
              {images.map((img) => (
                <ProxiedImage key={img.url} url={img.url} alt={img.alt} />
              ))}
            </div>
          )}
        </div>
        <div className={styles.detailSidebar}>
          <Stack gap="xs">
            <span className={styles.sidebarLabel}>Status</span>
            <Row align="center" gap="xxs" className={styles.sidebarValue}>
              <span className={styles.statusDot} />
              {issueDetail.state.name}
            </Row>
          </Stack>
          <Stack gap="xs">
            <span className={styles.sidebarLabel}>Priority</span>
            <Row align="center" gap="xxs" className={styles.sidebarValue}>
              <span
                className={styles.priorityDot}
                style={{ background: priority.color }}
              />
              {priority.label}
            </Row>
          </Stack>
          {issueDetail.assignee && (
            <Stack gap="xs">
              <span className={styles.sidebarLabel}>Assignee</span>
              <Row align="center" gap="xxs" className={styles.sidebarValue}>
                {issueDetail.assignee.displayName}
              </Row>
            </Stack>
          )}
          <Stack gap="xs">
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
              <Row align="center" gap="xxs" className={styles.sidebarValue}>No Labels</Row>
            )}
          </Stack>
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
            {canNewAgent && (
              <button
                className={styles.footerHint}
                onClick={() => handleNewAgent(issueDetail)}
              >
                <kbd className={styles.kbd}>Enter</kbd>
                <span>New Agent</span>
              </button>
            )}
            <button
              className={styles.footerHint}
              onClick={() => handleCreateWorkspace(issueDetail)}
            >
              <kbd className={styles.kbd}>Shift+Enter</kbd>
              <span>Create Workspace</span>
            </button>
          </>
        )}
        <button
          className={styles.footerHint}
          onClick={() => handleOpenInBrowser(issueDetail)}
        >
          <kbd className={styles.kbd}>&#8984;O</kbd>
          <span>Open in Browser</span>
        </button>
      </div>
    </>
  );
}

function ProxiedImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.linear.proxyImage(url).then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl);
    }).catch(() => {
      // Fallback to raw URL if proxy fails
      if (!cancelled) setSrc(url);
    });
    return () => { cancelled = true; };
  }, [url]);

  if (!src) return null;

  return (
    <img
      src={src}
      alt={alt || "Screenshot"}
      className={styles.detailScreenshot}
    />
  );
}
