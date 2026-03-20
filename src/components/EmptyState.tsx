import {
  type ReactNode,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  Terminal,
  Search,
  Trash2,
  FolderDown,
  ExternalLink,
} from "lucide-react";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { removeWorktreeWithToast } from "../store/workspace-actions";
import type { LinearIssue } from "../electron.d";
import styles from "./EmptyState.module.css";

interface ActionItem {
  icon: ReactNode;
  label: string;
  keys: string[];
  action: () => void;
  variant?: "danger";
}

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

  useEffect(() => {
    if (teamIds.length === 0) {
      setTickets([]);
      return;
    }

    let cancelled = false;
    (async () => {
      setTicketsLoading(true);
      try {
        const issues = await window.electronAPI.linearGetMyIssues(teamIds);
        if (!cancelled) setTickets(issues);
      } catch (err) {
        console.error("[EmptyState] Failed to fetch tickets:", err);
      } finally {
        if (!cancelled) setTicketsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamIds]);

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
                window.electronAPI.openExternal(issue.url);
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

/** Shown when there are no projects at all. */
export function WelcomeEmptyState() {
  const addProjectFromDirectory = useProjectStore(
    (s) => s.addProjectFromDirectory,
  );

  const actions: ActionItem[] = [
    {
      icon: <FolderDown size={16} />,
      label: "Import Project",
      keys: [],
      action: addProjectFromDirectory,
    },
  ];

  return (
    <EmptyStateShell
      subtitle="Open a project to get started"
      actions={actions}
    />
  );
}

function EmptyStateShell({
  subtitle,
  actions,
  ticketsSection,
}: {
  subtitle?: string;
  actions: ActionItem[];
  ticketsSection?: ReactNode;
}) {
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.logo}>
          <ManorLogo />
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {ticketsSection}
        <div className={styles.actions}>
          {actions.map((item) => (
            <button
              key={item.label}
              className={`${styles.action} ${item.variant === "danger" ? styles.actionDanger : ""}`}
              onClick={item.action}
            >
              <span className={styles.actionIcon}>{item.icon}</span>
              <span className={styles.actionLabel}>{item.label}</span>
              {item.keys.length > 0 && (
                <span className={styles.actionKeys}>
                  {item.keys.map((key) => (
                    <kbd key={key} className={styles.kbd}>
                      {key}
                    </kbd>
                  ))}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ManorLogo() {
  const s = 8;
  const g = 2;
  const step = s + g;
  const fill = "var(--text-primary)";
  // M on a 7-col x 5-row pixel grid
  const pixels = [
    [0, 0], [6, 0],
    [0, 1], [1, 1], [5, 1], [6, 1],
    [0, 2], [2, 2], [4, 2], [6, 2],
    [0, 3], [3, 3], [6, 3],
    [0, 4], [6, 4],
  ];
  return (
    <svg
      width={7 * s + 6 * g}
      height={5 * s + 4 * g}
      viewBox={`0 0 ${7 * s + 6 * g} ${5 * s + 4 * g}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {pixels.map(([col, row]) => (
        <rect
          key={`${col}-${row}`}
          x={col * step}
          y={row * step}
          width={s}
          height={s}
          fill={fill}
        />
      ))}
    </svg>
  );
}
