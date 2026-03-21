import {
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  Terminal,
  Search,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { removeWorktreeWithToast } from "../store/workspace-actions";
import { useMountEffect } from "../hooks/useMountEffect";
import type { LinearIssue } from "../electron.d";
import { EmptyStateShell, type ActionItem } from "./EmptyStateShell";
import styles from "./EmptyState.module.css";

/** Shown when the active workspace has no sessions (all tabs closed). */
export function WorkspaceEmptyState() {
  const addSession = useAppStore((s) => s.addSession);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const createWorktree = useProjectStore((s) => s.createWorktree);

  const project = projects[selectedProjectIndex];
  const workspace = project?.workspaces[project.selectedWorkspaceIndex];
  const isWorktree = workspace && !workspace.isMain;

  const teamIds = useMemo(
    () => project?.linearAssociations?.map((a) => a.teamId) ?? [],
    [project?.linearAssociations],
  );

  const [tickets, setTickets] = useState<LinearIssue[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [loadingTicketId, setLoadingTicketId] = useState<string | null>(null);

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

    return () => {
      cancelled = true;
      unsub();
    };
  });

  const projectId = project?.id;
  const handleTicketClick = useCallback(
    async (issue: LinearIssue) => {
      if (!projectId) return;
      setLoadingTicketId(issue.id);
      try {
        // Check if a workspace with matching branch already exists
        const current = useProjectStore
          .getState()
          .projects.find((p) => p.id === projectId);
        const existingIdx =
          current?.workspaces.findIndex(
            (ws) => ws.branch === issue.branchName,
          ) ?? -1;
        if (existingIdx >= 0) {
          selectWorkspace(projectId, existingIdx);
          const existingWs = current?.workspaces[existingIdx];
          if (existingWs) setActiveWorkspace(existingWs.path);
          return;
        }
        // Create new worktree (store handles selection and activation)
        await createWorktree(projectId, issue.identifier, issue.branchName);
      } finally {
        setLoadingTicketId(null);
      }
    },
    [projectId, selectWorkspace, createWorktree, setActiveWorkspace],
  );

  const actions: ActionItem[] = [
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

  const ticketsSection =
    tickets.length > 0 ? (
      <div className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Tickets</div>
        {tickets.map((issue) => (
          <div key={issue.id} className={styles.ticketRow}>
            <button
              className={styles.ticket}
              onClick={() => handleTicketClick(issue)}
              disabled={loadingTicketId === issue.id}
            >
              <span className={styles.ticketIdentifier}>
                {issue.identifier}
              </span>
              <span className={styles.ticketTitle}>{issue.title}</span>
              {loadingTicketId === issue.id && (
                <span className={styles.ticketSpinner} />
              )}
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
      </div>
    ) : ticketsLoading && teamIds.length > 0 ? (
      <div className={styles.ticketsSection}>
        <div className={styles.ticketsSectionHeader}>Your Tickets</div>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={styles.ticketLoading} />
        ))}
      </div>
    ) : null;

  return <EmptyStateShell actions={actions} ticketsSection={ticketsSection} />;
}
