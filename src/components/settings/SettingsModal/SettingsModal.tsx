import { Fragment, useState, useCallback, useRef, useMemo, useEffect } from "react";
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
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore } from "../../../store/host-store";
import { isRemoteHost, memberHostName } from "../../../lib/hosts";
import { useRestoreFocus } from "../../../hooks/useRestoreFocus";
import { GeneralSettingsPage } from "../GeneralSettingsPage";
import { AppSettingsPage } from "../AppSettingsPage";
import { KeybindingsPage } from "../KeybindingsPage";
import { NotificationsPage } from "../NotificationsPage";
import { IntegrationsPage } from "../IntegrationsPage";
import { RemoteControlPage } from "../RemoteControlPage";
import { GroupSettingsPage, ProjectSettingsPage } from "../ProjectSettingsPage";
import { HostIndicator } from "../../hosts/HostIndicator";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import {
  buildSettingsIndex,
  searchSettings,
  MACHINE_SECTION_IDS,
  type SettingsPage,
  type SettingsPageId,
  type SettingsProjectEntry,
  type SettingsSearchResult,
} from "./settings-search";
import styles from "./SettingsModal.module.css";

/** A page as a stable key, for React keys and the nav's active state. */
function pageKey(page: SettingsPage): string {
  if (page.type === "project") return `project:${page.projectId}`;
  if (page.type === "group") return `group:${page.groupId}`;
  return page.type;
}

/**
 * The page a project deep link opens (ADR-193): a grouped project's shared
 * settings are its group's page, unless the link names a section that lives
 * on the member's own page.
 */
function pageForProject(
  project: ProjectInfo | undefined,
  projectId: string,
  section: string | null | undefined,
): SettingsPage {
  if (project?.group && !(section && MACHINE_SECTION_IDS.includes(section))) {
    return { type: "group", groupId: project.group.id };
  }
  return { type: "project", projectId };
}

/** Fixed (non-project) settings pages that a command can deep-link to. */
export type { SettingsPageId };

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  initialProjectId?: string | null;
  initialPage?: SettingsPageId | null;
  /** A section to scroll to on open, e.g. `"project-host"`. */
  initialSection?: string | null;
};

export function SettingsModal(props: SettingsModalProps) {
  const { open, onClose, initialProjectId, initialPage, initialSection } = props;

  const { onCloseAutoFocus: restoreFocusOnClose } = useRestoreFocus(open);

  const projects = useProjectStore((s) => s.projects);
  const hosts = useHostStore((s) => s.hosts);
  const [page, setPage] = useState<SettingsPage>({ type: "general" });
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  /** A jump requested by search: `id` null means "open the page at the top". */
  const [pendingJump, setPendingJump] = useState<{
    id: string | null;
    nonce: number;
  } | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    if (initialProjectId) {
      setPage(
        pageForProject(
          projects.find((p) => p.id === initialProjectId),
          initialProjectId,
          initialSection,
        ),
      );
    } else if (initialPage) {
      setPage({ type: initialPage });
    } else {
      setPage({ type: "general" });
    }
    setProjectsExpanded(true);
    setQuery("");
    setHighlight(0);
    setPendingJump(initialSection ? { id: initialSection, nonce: 0 } : null);
  }
  prevOpenRef.current = open;

  // A linked group is listed once, where its first member would be, with a
  // row per member nested under it (ADR-193).
  const navProjects = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const entries: SettingsProjectEntry[] = [];
    for (const p of projects) {
      if (!p.group) {
        entries.push({ kind: "project", id: p.id, name: p.name });
        continue;
      }
      if (seen.has(p.group.id)) continue;
      seen.add(p.group.id);
      const members = p.group.memberIds
        .map((id) => byId.get(id))
        .filter((m): m is ProjectInfo => m !== undefined);
      entries.push({
        kind: "group",
        id: p.group.id,
        name: p.group.name,
        members: members.map((m) => ({
          id: m.id,
          hostId: m.hostId,
          hostLabel: memberHostName(m.hostId, hosts),
        })),
      });
    }
    return entries;
  }, [projects, hosts]);
  const index = useMemo(() => buildSettingsIndex(navProjects), [navProjects]);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const searching = query.trim().length > 0;

  const goToSection = useCallback((result: SettingsSearchResult) => {
    setPage(result.page);
    if (result.page.type === "project" || result.page.type === "group") {
      setProjectsExpanded(true);
    }
    setPendingJump({ id: result.id, nonce: Date.now() });
    setQuery("");
    setHighlight(0);
  }, []);

  // Jump to the picked target once its page renders: a section scrolls into
  // view and flashes, a whole page just opens at the top.
  useEffect(() => {
    if (!pendingJump) return;

    const frame = requestAnimationFrame(() => {
      const sectionId = pendingJump.id;
      setPendingJump(null);

      if (!sectionId) {
        contentRef.current?.scrollTo({ top: 0 });
        contentRef.current?.focus();
        return;
      }

      const target = contentRef.current?.querySelector<HTMLElement>(
        `[data-settings-section="${sectionId}"]`,
      );
      if (!target) return;

      target.scrollIntoView({ block: "start", behavior: "smooth" });
      target.classList.remove(styles.sectionFlash);
      // Reflow so the animation restarts when the same section is picked twice.
      void target.offsetWidth;
      target.classList.add(styles.sectionFlash);
      // Move keyboard focus to the section heading so Tab continues from
      // here, not from wherever the search input was left.
      target.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [pendingJump, page]);

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

  // ↑/↓ move focus between the nav's buttons (page links and the Projects
  // group header/rows alike) instead of falling through to browser scrolling.
  const handleNavKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const buttons = Array.from(
        e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
      );
      if (buttons.length === 0) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next =
        current === -1
          ? 0
          : (current + delta + buttons.length) % buttons.length;
      e.preventDefault();
      buttons[next]?.focus();
    },
    [],
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
  const currentGroupMembers = useMemo(() => {
    if (page.type !== "group") return [];
    const lead = projects.find((p) => p.group?.id === page.groupId);
    if (!lead?.group) return [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    return lead.group.memberIds
      .map((id) => byId.get(id))
      .filter((p): p is ProjectInfo => p !== undefined);
  }, [page, projects]);
  const currentGroup = currentGroupMembers[0]?.group ?? null;

  // When the open group dissolves (Unlink all, or unlinking down to one
  // member), fall back to the page of a project that was in it.
  const lastGroupMemberIdsRef = useRef<string[]>([]);
  if (page.type === "group") {
    if (currentGroup) {
      lastGroupMemberIdsRef.current = currentGroup.memberIds;
    } else {
      const former = projects.find((p) =>
        lastGroupMemberIdsRef.current.includes(p.id),
      );
      if (former) setPage({ type: "project", projectId: former.id });
    }
  }

  const isCurrentPage = (target: SettingsPage) =>
    pageKey(target) === pageKey(page);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          data-testid="settings-modal"
          className={styles.modal}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            searchRef.current?.focus();
          }}
          onCloseAutoFocus={restoreFocusOnClose}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close settings">
                <X size={16} />
              </Button>
            </Dialog.Close>
          </div>
          <div className={styles.layout}>
            <div className={styles.sidebar}>
              <div className={styles.searchWrap}>
                <Search size={13} className={styles.searchIcon} />
                <Input
                  ref={searchRef}
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
                      key={`${pageKey(result.page)}:${result.id ?? "page"}`}
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
                <nav className={styles.nav} onKeyDown={handleNavKeyDown}>
                  <button
                    data-testid="settings-nav-general"
                    className={`${styles.navItem} ${page.type === "general" ? styles.navItemActive : ""}`}
                    aria-current={page.type === "general" ? "page" : undefined}
                    onClick={() => setPage({ type: "general" })}
                  >
                    <Settings size={14} />
                    <span>General</span>
                  </button>

                  <button
                    data-testid="settings-nav-appearance"
                    className={`${styles.navItem} ${page.type === "app" ? styles.navItemActive : ""}`}
                    aria-current={page.type === "app" ? "page" : undefined}
                    onClick={() => setPage({ type: "app" })}
                  >
                    <Palette size={14} />
                    <span>Appearance</span>
                  </button>

                  <button
                    data-testid="settings-nav-keybindings"
                    className={`${styles.navItem} ${page.type === "keybindings" ? styles.navItemActive : ""}`}
                    aria-current={page.type === "keybindings" ? "page" : undefined}
                    onClick={() => setPage({ type: "keybindings" })}
                  >
                    <Keyboard size={14} />
                    <span>Keybindings</span>
                  </button>

                  <button
                    data-testid="settings-nav-notifications"
                    className={`${styles.navItem} ${page.type === "notifications" ? styles.navItemActive : ""}`}
                    aria-current={page.type === "notifications" ? "page" : undefined}
                    onClick={() => setPage({ type: "notifications" })}
                  >
                    <Bell size={14} />
                    <span>Notifications</span>
                  </button>

                  <button
                    data-testid="settings-nav-integrations"
                    className={`${styles.navItem} ${page.type === "integrations" ? styles.navItemActive : ""}`}
                    aria-current={page.type === "integrations" ? "page" : undefined}
                    onClick={() => setPage({ type: "integrations" })}
                  >
                    <Link size={14} />
                    <span>Integrations</span>
                  </button>

                  <button
                    data-testid="settings-nav-remote"
                    className={`${styles.navItem} ${page.type === "remote" ? styles.navItemActive : ""}`}
                    aria-current={page.type === "remote" ? "page" : undefined}
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
                    navProjects.map((entry) => {
                      const entryPage: SettingsPage =
                        entry.kind === "group"
                          ? { type: "group", groupId: entry.id }
                          : { type: "project", projectId: entry.id };
                      const active = isCurrentPage(entryPage);
                      return (
                        <Fragment key={entry.id}>
                          <button
                            data-testid={`settings-nav-${entry.kind}-${entry.id}`}
                            className={`${styles.navItem} ${styles.navItemNested} ${
                              active ? styles.navItemActive : ""
                            }`}
                            aria-current={active ? "page" : undefined}
                            onClick={() => setPage(entryPage)}
                          >
                            <span className={styles.navItemLabel}>
                              {entry.name}
                            </span>
                          </button>
                          {entry.kind === "group" &&
                            entry.members.map((member) => {
                              const memberPage: SettingsPage = {
                                type: "project",
                                projectId: member.id,
                              };
                              const memberActive = isCurrentPage(memberPage);
                              const remote = isRemoteHost(member.hostId);
                              return (
                                <button
                                  key={member.id}
                                  data-testid={`settings-nav-member-${member.id}`}
                                  className={`${styles.navItem} ${styles.navItemNested2} ${
                                    memberActive ? styles.navItemActive : ""
                                  }`}
                                  aria-current={memberActive ? "page" : undefined}
                                  onClick={() => setPage(memberPage)}
                                >
                                  {remote ? (
                                    <HostIndicator hostId={member.hostId} variant="icon" />
                                  ) : (
                                    <Laptop size={12} aria-hidden />
                                  )}
                                  <span className={styles.navItemLabel}>
                                    {member.hostLabel}
                                  </span>
                                </button>
                              );
                            })}
                        </Fragment>
                      );
                    })}
                  {projectsExpanded && projects.length === 0 && (
                    <div className={styles.navEmpty}>No projects</div>
                  )}
                </nav>
              )}
            </div>

            <div className={styles.content} ref={contentRef} tabIndex={-1}>
              {page.type === "general" && <GeneralSettingsPage />}
              {page.type === "app" && <AppSettingsPage />}
              {page.type === "keybindings" && <KeybindingsPage />}
              {page.type === "notifications" && <NotificationsPage />}
              {page.type === "integrations" && <IntegrationsPage />}
              {page.type === "remote" && <RemoteControlPage />}
              {page.type === "group" && currentGroup && (
                <GroupSettingsPage
                  key={currentGroup.id}
                  group={currentGroup}
                  members={currentGroupMembers}
                />
              )}
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
