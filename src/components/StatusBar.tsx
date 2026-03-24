import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const projects = useProjectStore((s) => s.projects);

  const project = projects.find((p) =>
    p.workspaces.some((w) => w.path === activeWorkspacePath),
  );

  const workspace = project?.workspaces.find(
    (w) => w.path === activeWorkspacePath,
  );

  const workspaceLabel = workspace
    ? (workspace.name ?? workspace.branch)
    : null;

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        {project && (
          <>
            <span className={styles.segment}>{project.name}</span>
            {workspaceLabel && (
              <>
                <span className={styles.separator}>&gt;</span>
                <span className={styles.segment}>{workspaceLabel}</span>
              </>
            )}
          </>
        )}
      </div>
      <div className={styles.right} />
    </div>
  );
}
