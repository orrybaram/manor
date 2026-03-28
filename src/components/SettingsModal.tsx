import { useState, useCallback, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  ChevronDown,
  ChevronRight,
  Palette,
  Keyboard,
  Bell,
  Link,
} from "lucide-react";
import { useProjectStore } from "../store/project-store";
import { AppSettingsPage } from "./AppSettingsPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { NotificationsPage } from "./NotificationsPage";
import { IntegrationsPage } from "./IntegrationsPage";
import { ProjectSettingsPage } from "./ProjectSettingsPage";
import styles from "./SettingsModal.module.css";

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  initialProjectId?: string | null;
};

type SettingsPage =
  | { type: "app" }
  | { type: "keybindings" }
  | { type: "notifications" }
  | { type: "integrations" }
  | { type: "project"; projectId: string };

export function SettingsModal(props: SettingsModalProps) {
  const { open, onClose, initialProjectId } = props;

  const projects = useProjectStore((s) => s.projects);
  const [page, setPage] = useState<SettingsPage>({ type: "app" });
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    if (initialProjectId) {
      setPage({ type: "project", projectId: initialProjectId });
    } else {
      setPage({ type: "app" });
    }
    setProjectsExpanded(true);
  }
  prevOpenRef.current = open;

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose],
  );

  const currentProject =
    page.type === "project"
      ? projects.find((p) => p.id === page.projectId)
      : null;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.modal}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document
              .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
              ?.focus();
          }}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button className={styles.closeButton}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className={styles.layout}>
            {/* Sidebar */}
            <nav className={styles.sidebar}>
              <button
                className={`${styles.navItem} ${page.type === "app" ? styles.navItemActive : ""}`}
                onClick={() => setPage({ type: "app" })}
              >
                <Palette size={14} />
                <span>Appearance</span>
              </button>

              <button
                className={`${styles.navItem} ${page.type === "keybindings" ? styles.navItemActive : ""}`}
                onClick={() => setPage({ type: "keybindings" })}
              >
                <Keyboard size={14} />
                <span>Keybindings</span>
              </button>

              <button
                className={`${styles.navItem} ${page.type === "notifications" ? styles.navItemActive : ""}`}
                onClick={() => setPage({ type: "notifications" })}
              >
                <Bell size={14} />
                <span>Notifications</span>
              </button>

              <button
                className={`${styles.navItem} ${page.type === "integrations" ? styles.navItemActive : ""}`}
                onClick={() => setPage({ type: "integrations" })}
              >
                <Link size={14} />
                <span>Integrations</span>
              </button>

              <button
                className={styles.navGroupHeader}
                onClick={() => setProjectsExpanded((v) => !v)}
              >
                {projectsExpanded ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
                <span>Projects</span>
              </button>
              {projectsExpanded &&
                projects.map((project) => (
                  <button
                    key={project.id}
                    className={`${styles.navItem} ${styles.navItemNested} ${
                      page.type === "project" && page.projectId === project.id
                        ? styles.navItemActive
                        : ""
                    }`}
                    onClick={() =>
                      setPage({ type: "project", projectId: project.id })
                    }
                  >
                    <span className={styles.navItemLabel}>{project.name}</span>
                  </button>
                ))}
              {projectsExpanded && projects.length === 0 && (
                <div className={styles.navEmpty}>No projects</div>
              )}
            </nav>

            {/* Content */}
            <div className={styles.content}>
              {page.type === "app" && <AppSettingsPage />}
              {page.type === "keybindings" && <KeybindingsPage />}
              {page.type === "notifications" && <NotificationsPage />}
              {page.type === "integrations" && <IntegrationsPage />}
              {page.type === "project" && currentProject && (
                <ProjectSettingsPage
                  key={currentProject.id}
                  project={currentProject}
                />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
