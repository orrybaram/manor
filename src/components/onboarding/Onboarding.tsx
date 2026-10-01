import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import FolderGit2 from "lucide-react/dist/esm/icons/folder-git-2";
import { ManorLogo } from "../ui/ManorLogo";
import { Button } from "../ui/Button/Button";
import { isWebApp } from "../../lib/platform";
import shared from "../EmptyState.module.css";
import styles from "./Onboarding.module.css";

export interface OnboardingProps {
  /** "Open a folder": the directory picker, straight away. */
  onAddLocal: () => void;
  /** "Clone from a repo": `AddProjectDialog` on its clone tab. */
  onClone: () => void;
}

/**
 * The zero-projects onboarding screen (ADR-194 §3): the logo and an
 * "Add a project" card. Shown in place of every surface until a project exists.
 */
export function Onboarding(props: OnboardingProps) {
  const { onAddLocal, onClone } = props;

  return (
    <div className={styles.container} data-testid="onboarding">
      <div className={styles.content}>
        <div className={shared.logo}>
          <ManorLogo />
        </div>
        <div className={styles.header}>
          <h1 className={styles.heading}>Projects</h1>
          <span className={styles.headerMeta}>No projects yet</span>
        </div>
        {isWebApp() ? (
          // No filesystem picker and no clone onto the host from a browser tab
          // (ADR-178): removed rather than left to open nothing, with one line
          // saying where projects come from instead.
          <div className={shared.subtitle}>
            Projects are added from the desktop app.
          </div>
        ) : (
          <div className={styles.addCard} data-testid="add-project-card">
            <span className={styles.addCardTitle}>Add a project</span>
            <Button
              variant="ghost"
              className={`${shared.action} ${styles.row}`}
              onClick={onAddLocal}
              data-testid="import-project-button"
            >
              <span className={shared.actionIcon}>
                <FolderPlus size={16} />
              </span>
              <span className={shared.actionLabel}>Open a folder</span>
            </Button>
            <Button
              variant="ghost"
              className={`${shared.action} ${styles.row}`}
              onClick={onClone}
              data-testid="add-remote-project-button"
            >
              <span className={shared.actionIcon}>
                <FolderGit2 size={16} />
              </span>
              <span className={shared.actionLabel}>Clone from a repo</span>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
