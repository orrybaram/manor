import { useAppStore } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import styles from "./Breadcrumbs.module.css";

export function Breadcrumbs() {
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const projects = useProjectStore((s) => s.projects);

  if (!activeWorkspacePath) return null;

  const project = projects.find((p) =>
    p.workspaces.some((w) => w.path === activeWorkspacePath),
  );

  if (!project) return null;

  const workspace = project.workspaces.find(
    (w) => w.path === activeWorkspacePath,
  );

  if (!workspace) return null;

  const workspaceLabel = workspace.name ?? workspace.branch;

  return (
    <div className={styles.breadcrumbs}>
      <span className={styles.segment}>{project.name}</span>
      <span className={styles.separator}>&gt;</span>
      <span className={styles.segment}>{workspaceLabel}</span>
    </div>
  );
}
