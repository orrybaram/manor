import { useState, useCallback, useMemo, useEffect } from "react";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Search from "lucide-react/dist/esm/icons/search";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Plus from "lucide-react/dist/esm/icons/plus";
import Globe from "lucide-react/dist/esm/icons/globe";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useToastStore } from "../../store/toast-store";
import { removeWorktreeWithToast } from "../../store/workspace-actions";
import { useMountEffect } from "../../hooks/useMountEffect";
import type { LinearIssue, GitHubIssue } from "../../electron.d";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
import { WorkspaceSetupView } from "./WorkspaceSetupView";
import type { PaletteView } from "../command-palette/types";
import { GitHubNudge } from "./GitHubNudge";
import { Stack } from "../ui/Layout/Layout";
import styles from "../EmptyState.module.css";

const INLINE_LIMIT = 5;

type WorkspaceEmptyStateProps = {
  onOpenIssueDetail?: (
    opts:
      | { type: "linear"; issueId: string }
      | { type: "github"; issueNumber: number },
  ) => void;
  onOpenPaletteView?: (view: PaletteView) => void;
};

/** Shown when the active workspace has no tabs. */
export function WorkspaceEmptyState(props: WorkspaceEmptyStateProps) {
  const { onOpenIssueDetail, onOpenPaletteView } = props;

  const addTab = useAppStore((s) => s.addTab);
  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const worktreeSetupState = useAppStore((s) => s.worktreeSetupState);
  const clearWorktreeSetup = useAppStore((s) => s.clearWorktreeSetup);
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
  const [githubNotInstalled, setGithubNotInstalled] = useState(false);
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
        if (!status.installed) {
          setGithubNotInstalled(true);
        } else if (status.installed && status.authenticated) {
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
      action: addTab,
    },
    {
      icon: <Globe size={16} />,
      label: "New Browser Window",
      keys: ["⌘", "⇧", "B"],
      action: () => addBrowserTab("about:blank"),
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

  const linearSection =
    inlineLinear.length > 0 ? (
      <Stack gap="2xs" className={styles.ticketsSection}>
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
        <button
          className={styles.viewAll}
          onClick={() => onOpenPaletteView?.("linear-all")}
        >
          View All Tickets
        </button>
      </Stack>
    ) : ticketsLoading && teamIds.length > 0 ? (
      <Stack gap="2xs" className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Tickets</div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={styles.ticketLoading} />
        ))}
      </Stack>
    ) : null;

  const githubSection =
    githubAvailable && githubIssues.length > 0 ? (
      <Stack gap="2xs" className={styles.ticketsSection}>
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
          onClick={() => onOpenPaletteView?.("github-all")}
        >
          View All Issues
        </button>
      </Stack>
    ) : githubAvailable && githubLoading ? (
      <Stack gap="2xs" className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Issues</div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={styles.ticketLoading} />
        ))}
      </Stack>
    ) : null;

  const handleGitHubInstalled = useCallback(() => {
    const state = useProjectStore.getState();
    const proj = state.projects[state.selectedProjectIndex];
    const repoPath = proj?.path;
    if (!repoPath) return;

    setGithubNotInstalled(false);
    setGithubAvailable(true);
    setGithubLoading(true);

    window.electronAPI.github
      .getMyIssues(repoPath, INLINE_LIMIT)
      .then((issues) => setGithubIssues(issues))
      .catch((err) =>
        console.error("[EmptyState] Failed to fetch GitHub issues:", err),
      )
      .finally(() => setGithubLoading(false));
  }, []);

  const githubNudge =
    githubNotInstalled && !githubAvailable ? (
      <GitHubNudge onInstalled={handleGitHubInstalled} />
    ) : null;

  const ticketsSection =
    linearSection || githubSection || githubNudge ? (
      <>
        {linearSection}
        {githubSection}
        {githubNudge}
      </>
    ) : null;

  // Check for active worktree setup (try actual path, then pending key)
  const setupKey = activeWorkspacePath && worktreeSetupState[activeWorkspacePath]
    ? activeWorkspacePath
    : worktreeSetupState["__pending__"]
      ? "__pending__"
      : null;
  const setupState = setupKey ? worktreeSetupState[setupKey] : null;
  const setupActive = !!(setupState && !setupState.completed && setupKey);

  // Track transition phase: "setup" | "transitioning" | "done"
  const [phase, setPhase] = useState<"setup" | "transitioning" | "done">(
    setupActive ? "setup" : "done",
  );

  // When setup becomes active, switch to setup phase
  useEffect(() => {
    if (setupActive && phase === "done") {
      setPhase("setup");
    }
  }, [setupActive, phase]);

  const handleSetupComplete = useCallback(() => {
    // Show success toast
    useToastStore.getState().addToast({
      id: `workspace-setup-${Date.now()}`,
      message: "Workspace setup complete",
      status: "success",
    });
    // Start cross-fade transition
    setPhase("transitioning");
  }, []);

  const handleFadeInEnd = useCallback(() => {
    if (phase === "transitioning" && setupKey) {
      clearWorktreeSetup(setupKey);
      setPhase("done");
    }
  }, [phase, setupKey, clearWorktreeSetup]);

  if (phase === "setup" && setupKey) {
    return (
      <WorkspaceSetupView
        workspacePath={setupKey}
        onComplete={handleSetupComplete}
      />
    );
  }

  return (
    <div
      className={phase === "transitioning" ? styles.fadeIn : undefined}
      onAnimationEnd={handleFadeInEnd}
      style={{ height: "100%" }}
    >
      <EmptyStateShell actions={actions} ticketsSection={ticketsSection} />
    </div>
  );
}
