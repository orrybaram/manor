import { type ReactNode } from "react";
import { Terminal, Search, Trash2, FolderDown } from "lucide-react";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
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
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const removeWorktree = useProjectStore((s) => s.removeWorktree);

  const project = projects[selectedProjectIndex];
  const workspace = project?.workspaces[project.selectedWorkspaceIndex];
  const isWorktree = workspace && !workspace.isMain;

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
          new KeyboardEvent("keydown", { key: "k", metaKey: true })
        );
      },
    },
  ];

  if (isWorktree && project) {
    actions.push({
      icon: <Trash2 size={16} />,
      label: "Delete Worktree",
      keys: [],
      action: () => removeWorktree(project.id, workspace.path),
      variant: "danger",
    });
  }

  return <EmptyStateShell actions={actions} />;
}

/** Shown when there are no projects at all. */
export function WelcomeEmptyState() {
  const addProjectFromDirectory = useProjectStore((s) => s.addProjectFromDirectory);

  const actions: ActionItem[] = [
    {
      icon: <FolderDown size={16} />,
      label: "Import Project",
      keys: [],
      action: addProjectFromDirectory,
    },
  ];

  return <EmptyStateShell subtitle="Open a project to get started" actions={actions} />;
}

function EmptyStateShell({
  subtitle,
  actions,
}: {
  subtitle?: string;
  actions: ActionItem[];
}) {
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.logo}>
          <ManorLogo />
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
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
  return (
    <svg
      width="80"
      height="48"
      viewBox="0 0 80 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Left bracket { */}
      <path
        d="M8 8 L16 8 L16 12 L12 12 L12 20 L16 20 L16 28 L12 28 L12 36 L16 36 L16 40 L8 40 L8 36 L4 36 L4 28 L8 28 L8 20 L4 20 L4 12 L8 12 Z"
        fill="var(--text-dim)"
      />
      {/* Center { } */}
      <path
        d="M28 8 L36 8 L36 12 L32 12 L32 20 L36 20 L36 28 L32 28 L32 36 L36 36 L36 40 L28 40 L28 36 L24 36 L24 28 L28 28 L28 20 L24 20 L24 12 L28 12 Z"
        fill="var(--text-primary)"
      />
      <path
        d="M44 8 L52 8 L52 12 L56 12 L56 20 L52 20 L52 28 L56 28 L56 36 L52 36 L52 40 L44 40 L44 36 L48 36 L48 28 L44 28 L44 20 L48 20 L48 12 L44 12 Z"
        fill="var(--text-primary)"
      />
      {/* Right bracket } */}
      <path
        d="M64 8 L72 8 L72 12 L76 12 L76 20 L72 20 L72 28 L76 28 L76 36 L72 36 L72 40 L64 40 L64 36 L68 36 L68 28 L64 28 L64 20 L68 20 L68 12 L64 12 Z"
        fill="var(--text-dim)"
      />
    </svg>
  );
}
