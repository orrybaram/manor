import { useState } from "react";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { ManorLogo } from "./ManorLogo";
import { AboutModal } from "./AboutModal";
import { LinearIcon } from "./CommandPalette/LinearIcon";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const [aboutOpen, setAboutOpen] = useState(false);
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

  const linkedIssues = workspace?.linkedIssues ?? [];

  const handleLinearClick = () => {
    // Placeholder — popover wired in ticket 4
  };

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
            {linkedIssues.length > 0 && (
              <>
                <span className={styles.separator}>&gt;</span>
                <button
                  className={styles.linearSection}
                  onClick={handleLinearClick}
                >
                  <LinearIcon size={12} />
                  <span>
                    {linkedIssues.length === 1
                      ? linkedIssues[0].identifier
                      : `${linkedIssues.length} issues`}
                  </span>
                </button>
              </>
            )}
          </>
        )}
      </div>
      <div className={styles.right}>
        <button
          className={styles.logoButton}
          onClick={() => setAboutOpen(true)}
          aria-label="About Manor"
        >
          <ManorLogo />
        </button>
      </div>
      <AboutModal open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  );
}
