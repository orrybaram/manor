import { useState, useCallback, useMemo } from "react";
import { Terminal, Search, Trash2, ExternalLink, Plus } from "lucide-react";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { removeWorktreeWithToast } from "../store/workspace-actions";
import { useMountEffect } from "../hooks/useMountEffect";
import type { LinearIssue, GitHubIssue } from "../electron.d";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
import type { PaletteView } from "./CommandPalette/types";
import styles from "./EmptyState.module.css";

const INLINE_LIMIT = 5;

interface WorkspaceEmptyStateProps {
  onOpenIssueDetail?: (
    opts:
      | { type: "linear"; issueId: string }
      | { type: "github"; issueNumber: number },
  ) => void;
  onOpenPaletteView?: (view: PaletteView) => void;
}

/** Shown when the active workspace has no sessions (all tabs closed). */
export function WorkspaceEmptyState({
  onOpenIssueDetail,
  onOpenPaletteView,
}: WorkspaceEmptyStateProps) {
  const addSession = useAppStore((s) => s.addSession);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);

  const project = projects[selectedProjectIndex];
  const workspace = project?.workspaces[project.selectedWorkspaceIndex];
  const isWorktree = workspace && !workspace.isMain;

  const teamIds = useMemo(
    () => project?.linearAssociations?.map((a) => a.teamId) ?? [],
    [project?.linearAssociations],
  );

  const [tickets, setTickets] = useState<LinearIssue[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);

  const [githubAvailable, setGithubAvailable] = useState(false);
  const [githubIssues, setGithubIssues] = useState<GitHubIssue[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);

  useMountEffect(() => {
    let cancelled = false;

    const getTeamIds = () => {
      const state = useProjectStore.getState();
      const proj = state.projects[state.selectedProjectIndex];
      return proj?.linearAssociations?.map((a) => a.teamId) ?? [];
    };

    const fetchTickets = async (ids: string[]) => {
      if (ids.length === 0) {
        setTickets([]);
        setTicketsLoading(false);
        return;
      }
      setTicketsLoading(true);
      try {
        const issues = await window.electronAPI.linear.getMyIssues(ids);
        if (!cancelled) setTickets(issues);
      } catch (err) {
        console.error("[EmptyState] Failed to fetch tickets:", err);
      } finally {
        if (!cancelled) setTicketsLoading(false);
      }
    };

    let prevKey = getTeamIds().join(",");
    fetchTickets(getTeamIds());

    const unsub = useProjectStore.subscribe(() => {
      const ids = getTeamIds();
      const key = ids.join(",");
      if (key !== prevKey) {
        prevKey = key;
        fetchTickets(ids);
      }
    });

    const fetchGitHubIssues = async () => {
      const state = useProjectStore.getState();
      const proj = state.projects[state.selectedProjectIndex];
      const repoPath = proj?.path;
      if (!repoPath) return;
      try {
        const status = await window.electronAPI.github.checkStatus();
        if (cancelled) return;
        if (status.installed && status.authenticated) {
          setGithubAvailable(true);
          setGithubLoading(true);
          try {
            const issues = await window.electronAPI.github.getMyIssues(
              repoPath,
              INLINE_LIMIT,
            );
            if (!cancelled) setGithubIssues(issues);
          } catch (err) {
            console.error("[EmptyState] Failed to fetch GitHub issues:", err);
          } finally {
            if (!cancelled) setGithubLoading(false);
          }
        }
      } catch (err) {
        console.error("[EmptyState] Failed to check GitHub status:", err);
      }
    };

    fetchGitHubIssues();

    return () => {
      cancelled = true;
      unsub();
    };
  });

  const handleTicketClick = useCallback(
    (issue: LinearIssue) => {
      onOpenIssueDetail?.({ type: "linear", issueId: issue.id });
    },
    [onOpenIssueDetail],
  );

  const handleGitHubIssueClick = useCallback(
    (issue: GitHubIssue) => {
      onOpenIssueDetail?.({ type: "github", issueNumber: issue.number });
    },
    [onOpenIssueDetail],
  );

  const actions: ActionItem[] = [
    {
      icon: <Plus size={16} />,
      label: "New Task",
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
      action: addSession,
    },
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

  const inlineLinear = tickets.slice(0, INLINE_LIMIT);
  const hasMoreLinear = tickets.length > INLINE_LIMIT;

  const linearSection =
    inlineLinear.length > 0 ? (
      <div className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Tickets</div>
        {inlineLinear.map((issue) => (
          <div key={issue.id} className={styles.ticketRow}>
            <button
              className={styles.ticket}
              onClick={() => handleTicketClick(issue)}
            >
              <span className={styles.ticketIdentifier}>
                {issue.identifier}
              </span>
              <span className={styles.ticketTitle}>{issue.title}</span>
            </button>
            <button
              className={styles.ticketLink}
              onClick={(e) => {
                e.stopPropagation();
                window.electronAPI.shell.openExternal(issue.url);
              }}
              title="View on Linear"
            >
              <ExternalLink size={14} />
            </button>
          </div>
        ))}
        {hasMoreLinear && (
          <button
            className={styles.viewAll}
            onClick={() => onOpenPaletteView?.("linear")}
          >
            View All Tickets
          </button>
        )}
      </div>
    ) : ticketsLoading && teamIds.length > 0 ? (
      <div className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Tickets</div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={styles.ticketLoading} />
        ))}
      </div>
    ) : null;

  const githubSection =
    githubAvailable && githubIssues.length > 0 ? (
      <div className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Issues</div>
        {githubIssues.map((issue) => (
          <div key={issue.number} className={styles.ticketRow}>
            <button
              className={styles.ticket}
              onClick={() => handleGitHubIssueClick(issue)}
            >
              <span className={styles.ticketIdentifier}>#{issue.number}</span>
              <span className={styles.ticketTitle}>{issue.title}</span>
            </button>
            <button
              className={styles.ticketLink}
              onClick={(e) => {
                e.stopPropagation();
                window.electronAPI.shell.openExternal(issue.url);
              }}
              title="View on GitHub"
            >
              <ExternalLink size={14} />
            </button>
          </div>
        ))}
        <button
          className={styles.viewAll}
          onClick={() => onOpenPaletteView?.("github")}
        >
          View All Issues
        </button>
      </div>
    ) : githubAvailable && githubLoading ? (
      <div className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Issues</div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={styles.ticketLoading} />
        ))}
      </div>
    ) : null;

  const ticketsSection =
    linearSection || githubSection ? (
      <>
        {linearSection}
        {githubSection}
      </>
    ) : null;

  return <EmptyStateShell actions={actions} ticketsSection={ticketsSection} />;
}
