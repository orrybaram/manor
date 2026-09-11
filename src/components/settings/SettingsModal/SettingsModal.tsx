import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import Search from "lucide-react/dist/esm/icons/search";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Palette from "lucide-react/dist/esm/icons/palette";
import Settings from "lucide-react/dist/esm/icons/settings";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import Bell from "lucide-react/dist/esm/icons/bell";
import Link from "lucide-react/dist/esm/icons/link";
import Bot from "lucide-react/dist/esm/icons/bot";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import { useProjectStore } from "../../../store/project-store";
import { GeneralSettingsPage } from "../GeneralSettingsPage";
import { AppSettingsPage } from "../AppSettingsPage";
import { KeybindingsPage } from "../KeybindingsPage";
import { NotificationsPage } from "../NotificationsPage";
import { IntegrationsPage } from "../IntegrationsPage";
import { HomeSettingsPage } from "../HomeSettingsPage";
import { RemoteControlPage } from "../RemoteControlPage";
import { ProjectSettingsPage } from "../ProjectSettingsPage";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import {
  buildSettingsIndex,
  searchSettings,
  type SettingsPageId,
  type SettingsSearchResult,
} from "./settings-search";
import styles from "./SettingsModal.module.css";

type SettingsPage =
  | { type: SettingsPageId }
  | { type: "project"; projectId: string };

/** Fixed (non-project) settings pages that a command can deep-link to. */
export type { SettingsPageId };

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  initialProjectId?: string | null;
  initialPage?: SettingsPageId | null;
};

export function SettingsModal(props: SettingsModalProps) {
  const { open, onClose, initialProjectId, initialPage } = props;

  const projects = useProjectStore((s) => s.projects);
  const [page, setPage] = useState<SettingsPage>({ type: "general" });
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [pendingSection, setPendingSection] = useState<string | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);

  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    if (initialProjectId) {
      setPage({ type: "project", projectId: initialProjectId });
    } else if (initialPage) {
      setPage({ type: initialPage });
    } else {
      setPage({ type: "general" });
    }
    setProjectsExpanded(true);
    setQuery("");
    setHighlight(0);
    setPendingSection(null);
  }
  prevOpenRef.current = open;

  const index = useMemo(() => buildSettingsIndex(projects), [projects]);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const searching = query.trim().length > 0;

  const goToSection = useCallback((result: SettingsSearchResult) => {
    setPage(result.page);
    if (result.page.type === "project") setProjectsExpanded(true);
    setPendingSection(result.id);
    setQuery("");
    setHighlight(0);
  }, []);

  // Scroll the freshly navigated-to section into view once its page renders.
  useEffect(() => {
    if (!pendingSection) return;

    const frame = requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[data-settings-section="${pendingSection}"]`,
      );
      setPendingSection(null);
      if (!target) return;

      target.scrollIntoView({ block: "start", behavior: "smooth" });
      target.classList.remove(styles.sectionFlash);
      // Reflow so the animation restarts when the same section is picked twice.
      void target.offsetWidth;
      target.classList.add(styles.sectionFlash);
    });

    return () => cancelAnimationFrame(frame);
  }, [pendingSection, page]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!searching) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => (results.length ? (i + 1) % results.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) =>
          results.length ? (i - 1 + results.length) % results.length : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const result = results[highlight];
        if (result) goToSection(result);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
        setHighlight(0);
      }
    },
    [searching, results, highlight, goToSection],
  );

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
          data-testid="settings-modal"
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
              <Button variant="ghost" size="sm">
                <X size={16} />
              </Button>
            </Dialog.Close>
          </div>
          <div className={styles.layout}>
            <div className={styles.sidebar}>
              <div className={styles.searchWrap}>
                <Search size={13} className={styles.searchIcon} />
                <Input
                  data-testid="settings-search"
                  className={styles.searchInput}
                  type="text"
                  placeholder="Search settings..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                />
              </div>

              {searching ? (
                <div
                  data-testid="settings-search-results"
                  className={styles.searchResults}
                >
                  {results.map((result, i) => (
                    <button
                      key={`${result.page.type}:${"projectId" in result.page ? result.page.projectId : ""}:${result.id}`}
                      className={`${styles.resultItem} ${i === highlight ? styles.resultItemActive : ""}`}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => goToSection(result)}
                    >
                      <span className={styles.resultLabel}>{result.label}</span>
                      {result.pageLabel !== result.label && (
                        <span className={styles.resultPage}>
                          {result.pageLabel}
                        </span>
                      )}
                    </button>
                  ))}
                  {results.length === 0 && (
                    <div className={styles.navEmpty}>No matches</div>
                  )}
                </div>
              ) : (
                <nav className={styles.nav}>
                  <button
                    className={`${styles.navItem} ${page.type === "general" ? styles.navItemActive : ""}`}
                    onClick={() => setPage({ type: "general" })}
                  >
                    <Settings size={14} />
                    <span>General</span>
                  </button>

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
                    className={`${styles.navItem} ${page.type === "home" ? styles.navItemActive : ""}`}
                    onClick={() => setPage({ type: "home" })}
                  >
                    <Bot size={14} />
                    <span>Home</span>
                  </button>

                  <button
                    data-testid="settings-nav-remote"
                    className={`${styles.navItem} ${page.type === "remote" ? styles.navItemActive : ""}`}
                    onClick={() => setPage({ type: "remote" })}
                  >
                    <Smartphone size={14} />
                    <span>Remote control</span>
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
                          page.type === "project" &&
                          page.projectId === project.id
                            ? styles.navItemActive
                            : ""
                        }`}
                        onClick={() =>
                          setPage({ type: "project", projectId: project.id })
                        }
                      >
                        <span className={styles.navItemLabel}>
                          {project.name}
                        </span>
                      </button>
                    ))}
                  {projectsExpanded && projects.length === 0 && (
                    <div className={styles.navEmpty}>No projects</div>
                  )}
                </nav>
              )}
            </div>

            <div className={styles.content} ref={contentRef}>
              {page.type === "general" && <GeneralSettingsPage />}
              {page.type === "app" && <AppSettingsPage />}
              {page.type === "keybindings" && <KeybindingsPage />}
              {page.type === "notifications" && <NotificationsPage />}
              {page.type === "integrations" && <IntegrationsPage />}
              {page.type === "home" && <HomeSettingsPage />}
              {page.type === "remote" && <RemoteControlPage />}
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
