import { useMemo, useCallback, useState, useRef, Fragment } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import { useAppStore, selectActiveWorkspaceKey } from "../../store/app-store";
import { ownerOf } from "../../lib/workspace-directory";
import { workspaceKey } from "../../lib/workspace-key";
import { useRestoreFocus } from "../../hooks/useRestoreFocus";
import { useProjectStore } from "../../store/project-store";
import {
  useCommandUsageStore,
  rankCommandIds,
} from "../../store/command-usage-store";
import { useWorkspaceCommands } from "./useWorkspaceCommands";
import { useCommands } from "./useCommands";
import { useAgentCommands } from "./useAgentCommands";
import { useCustomCommands } from "./useCustomCommands";
import { usePortsData } from "../ports/usePortsData";
import { LinearIcon } from "./LinearIcon";
import { GitHubIcon } from "./GitHubIcon";
import { LinearIssuesView } from "./LinearIssuesView";
import { GitHubIssuesView } from "./GitHubIssuesView";
import { IssueDetailView } from "./IssueDetailView";
import { GitHubIssueDetailView } from "./GitHubIssueDetailView";
import { ProcessesView, KillAllFooter } from "./ProcessesView";
import { StatsView } from "./StatsView";
import { wordPrefixFilter } from "./utils";
import { resolvePaletteScope } from "./scope";
import { ScopeChip } from "./ScopeChip";
import type {
  CommandPaletteProps,
  PaletteView,
  CategoryConfig,
  CommandItem,
} from "./types";
import { Row } from "../ui/Layout/Layout";
import { ghRepoOf } from "../../lib/gh-repo";
import styles from "./CommandPalette.module.css";

const HIDDEN_STYLE = { display: "none" } as const;

/** How many frequently used commands to pin at the top of the root view. */
const FREQUENT_LIMIT = 5;

const FREQUENT_CATEGORY_ID = "frequent";

/** Heading of the Agents group; also what agent rows match against. */
const AGENTS_HEADING = "Agents";

const IS_MAC =
  typeof navigator !== "undefined" &&
  navigator.platform.toLowerCase().includes("mac");

/** The widen-to-global shortcut, as shown in hints. */
const WIDEN_HINT = IS_MAC ? "⌘↵" : "Ctrl+↵";

/** Keyword marking an item of the Frequently Used group for `paletteFilter`. */
const FREQUENT_KEYWORD = "\u0000frequent";

/** The string cmdk matches a root command against. */
function itemValue(heading: string, cmd: CommandItem): string {
  return `${heading} ${cmd.label} ${cmd.keywords?.join(" ") ?? ""}`;
}

/**
 * Separates an item's searchable text from its identity suffix. cmdk tracks
 * selection by value, so items with the same text (a local and a remote
 * `main` under one project group, or a Frequently Used item and its home
 * copy) would highlight together without a unique suffix.
 */
const VALUE_ID_SEPARATOR = "\u001f";

/** A cmdk value unique per rendered item; `paletteFilter` ignores the suffix. */
function uniqueItemValue(
  heading: string,
  cmd: CommandItem,
  categoryId: string,
): string {
  return `${itemValue(heading, cmd)}${VALUE_ID_SEPARATOR}${categoryId}:${cmd.id}`;
}

/**
 * `wordPrefixFilter`, plus a lift for Frequently Used items. cmdk orders
 * groups and items by score, so a matching frequent command outranks every
 * other match and its group stays on top while searching.
 */
function paletteFilter(
  value: string,
  search: string,
  keywords?: string[],
): number {
  const score = wordPrefixFilter(value.split(VALUE_ID_SEPARATOR)[0], search);
  return score > 0 && keywords?.includes(FREQUENT_KEYWORD) ? score + 1 : score;
}

export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose, onOpenSettings, onNewWorkspace, onResumeAgent, onViewAllAgents, onNewAgent, onNewAgentWithPrompt, onRunCommand, initialView, initialIssueId, initialGitHubIssueNumber, origin = "shortcut" } = props;

  const { onCloseAutoFocus: restoreFocusOnClose } = useRestoreFocus(open);

  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceKey = useAppStore(selectActiveWorkspaceKey);
  const activeSurface = useAppStore((s) => s.activeSurface);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const commandUsage = useCommandUsageStore((s) => s.usage);
  const recordCommandUsage = useCommandUsageStore((s) => s.record);

  const { ports } = usePortsData();
  const activePorts = useMemo(
    () =>
      ports.filter(
        (p) =>
          !!p.workspacePath &&
          workspaceKey(p.hostId, p.workspacePath) === activeWorkspaceKey,
      ),
    [ports, activeWorkspaceKey],
  );

  const [view, setView] = useState<PaletteView>("root");
  const [search, setSearch] = useState("");
  const [linearConnected, setLinearConnected] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedGitHubIssueNumber, setSelectedGitHubIssueNumber] = useState<
    number | null
  >(null);
  const [issueListOrigin, setIssueListOrigin] = useState<PaletteView>("linear-all");
  const [issueListEmpty, setIssueListEmpty] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scope (ADR-200): the project the root view is narrowed to, or `null` for
  // all projects. `openedScopeProjectId` is what the palette opened with, so
  // Tab can toggle back to it after widening.
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const [openedScopeProjectId, setOpenedScopeProjectId] = useState<
    string | null
  >(null);
  const [scopeArmed, setScopeArmed] = useState(false);
  // The project whose tracker the issue views read, set by the drill-in row.
  const [trackerProjectId, setTrackerProjectId] = useState<string | null>(null);

  // Derive the active project from the active workspace; on surfaces with no
  // workspace (home) fall back to the sidebar's selected project so issue
  // lists still resolve a tracker.
  const activeProject = useMemo(
    () =>
      ownerOf(projects, activeWorkspaceKey) ??
      projects[selectedProjectIndex] ??
      null,
    [projects, activeWorkspaceKey, selectedProjectIndex],
  );

  const scopeProject = useMemo(
    () =>
      scopeProjectId
        ? (projects.find((p) => p.id === scopeProjectId) ?? null)
        : null,
    [projects, scopeProjectId],
  );

  // The project the issue views read: the drilled-in row's project, else the
  // scoped project, else the active project (so `initialView` deep links work).
  const trackerProject = useMemo(
    () =>
      (trackerProjectId
        ? projects.find((p) => p.id === trackerProjectId)
        : undefined) ??
      scopeProject ??
      activeProject,
    [projects, trackerProjectId, scopeProject, activeProject],
  );

  // Team IDs from the tracker project's Linear associations
  const allTeamIds = useMemo(
    () => (trackerProject?.linearAssociations ?? []).map((a) => a.teamId),
    [trackerProject],
  );

  // The tracker project's checkout, on its host (ADR-191).
  const repo = useMemo(
    () => (trackerProject ? ghRepoOf(trackerProject) : null),
    [trackerProject],
  );

  // Check connection status when palette opens (render-time, ref-guarded)
  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    window.electronAPI.linear
      .isConnected()
      .then(setLinearConnected)
      .catch(() => setLinearConnected(false));
    window.electronAPI.github
      .checkStatus()
      .then((s) => setGithubConnected(s.installed && s.authenticated))
      .catch(() => setGithubConnected(false));

    const openedScope = resolvePaletteScope({
      origin,
      activeSurface,
      activeWorkspaceKey,
      projects,
    });
    setScopeProjectId(openedScope);
    setOpenedScopeProjectId(openedScope);
    setScopeArmed(false);

    // Apply initial view state if provided
    if (initialView) {
      setView(initialView);
      if (initialIssueId != null) setSelectedIssueId(initialIssueId);
      if (initialGitHubIssueNumber != null)
        setSelectedGitHubIssueNumber(initialGitHubIssueNumber);
    }
  }
  prevOpenRef.current = open;

  const handleClose = useCallback(() => {
    setView("root");
    setSearch("");
    setSelectedIssueId(null);
    setSelectedGitHubIssueNumber(null);
    setIssueListEmpty(false);
    setScopeProjectId(null);
    setOpenedScopeProjectId(null);
    setScopeArmed(false);
    setTrackerProjectId(null);
    onClose();
  }, [onClose]);

  const navigateToLinearAll = useCallback((projectId: string) => {
    setTrackerProjectId(projectId);
    setSearch("");
    setView("linear-all");
  }, []);

  const navigateToGitHubAll = useCallback((projectId: string) => {
    setTrackerProjectId(projectId);
    setSearch("");
    setView("github-all");
  }, []);

  /** Drops the project scope; the query stays. */
  const widenScope = useCallback(() => {
    setScopeProjectId(null);
    setScopeArmed(false);
    listRef.current?.scrollTo(0, 0);
    inputRef.current?.focus();
  }, []);

  const navigateToProcesses = useCallback(() => {
    setSearch("");
    setView("processes");
  }, []);

  const navigateToStats = useCallback(() => {
    setSearch("");
    setView("stats");
  }, []);

  const navigateToRoot = useCallback(() => {
    setSearch("");
    setSelectedIssueId(null);
    setSelectedGitHubIssueNumber(null);
    setView("root");
  }, []);

  const navigateBackToList = useCallback(() => {
    setSearch("");
    setSelectedIssueId(null);
    setSelectedGitHubIssueNumber(null);
    setView(issueListOrigin);
  }, [issueListOrigin]);

  const { workspaceGroups } = useWorkspaceCommands({
    projects,
    activeWorkspacePath,
    selectWorkspace,
    onClose: handleClose,
    onNewWorkspace,
    enabled: open,
  });

  const commandCategories = useCommands({
    addBrowserTab,
    onClose: handleClose,
    onOpenSettings,
    onRunCommand,
    activePorts,
    navigateToProcesses,
    navigateToStats,
  });

  const agentCommands = useAgentCommands({
    onResumeAgent,
    onViewAllAgents,
    onClose: handleClose,
    onNewAgent,
    scopeProjectId,
    enabled: open,
  });

  const scopedWorkspaceGroups = useMemo(
    () =>
      scopeProjectId
        ? workspaceGroups.filter((g) => g.projectId === scopeProjectId)
        : workspaceGroups,
    [workspaceGroups, scopeProjectId],
  );

  const customCommands = useCustomCommands({
    onClose: handleClose,
    activeWorkspaceKey,
    enabled: open,
  });

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) handleClose();
    },
    [handleClose],
  );

  const handleOpenAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
  }, []);

  const handleCloseAutoFocus = restoreFocusOnClose;

  const handleEscapeKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (view === "issue-detail" || view === "github-issue-detail") {
        e.preventDefault();
        navigateBackToList();
        return;
      }
      if (view !== "root") {
        e.preventDefault();
        navigateToRoot();
        return;
      }
      // An armed scope chip (Backspace on an empty query) clears on Escape
      // instead of closing the palette.
      if (scopeArmed) {
        e.preventDefault();
        widenScope();
      }
    },
    [view, navigateToRoot, navigateBackToList, scopeArmed, widenScope],
  );

  const isIssueListView =
    view === "linear-all" ||
    view === "github-all" ||
    view === "processes" ||
    view === "stats";
  const isDetailView =
    view === "issue-detail" || view === "github-issue-detail";

  // Tracker drill-ins: one row for the scoped project, or one per project
  // with a tracker when global.
  const trackerProjects = useMemo(
    () => (scopeProject ? [scopeProject] : projects),
    [scopeProject, projects],
  );

  const linearItems = useMemo<CommandItem[]>(() => {
    if (!linearConnected) return [];
    return trackerProjects
      .filter((p) => p.linearAssociations.length > 0)
      .map((p) => ({
        id: scopeProject ? "linear-issues" : `linear-issues-${p.id}`,
        label: scopeProject ? "Tasks" : `${p.name} Tasks`,
        icon: <LinearIcon size={14} />,
        suffix: <ChevronRight size={14} />,
        action: () => navigateToLinearAll(p.id),
      }));
  }, [linearConnected, trackerProjects, scopeProject, navigateToLinearAll]);

  const githubItems = useMemo<CommandItem[]>(() => {
    if (!githubConnected) return [];
    return trackerProjects
      .filter((p) => ghRepoOf(p) !== null)
      .map((p) => ({
        id: scopeProject ? "github-issues" : `github-issues-${p.id}`,
        label: scopeProject ? "Tasks" : `${p.name} Tasks`,
        icon: <GitHubIcon size={14} />,
        suffix: <ChevronRight size={14} />,
        action: () => navigateToGitHubAll(p.id),
        keywords: ["ticket"],
      }));
  }, [githubConnected, trackerProjects, scopeProject, navigateToGitHubAll]);

  const categories = useMemo<CategoryConfig[]>(() => {
    const workspaceCategories: CategoryConfig[] = scopedWorkspaceGroups.map(
      (group) => ({
        id: `workspace-${group.projectId}`,
        heading: group.heading,
        visible: true,
        items: group.items,
      }),
    );

    // "Go to" (Dashboard, Tasks, Projects) leads the list, ahead of the
    // per-project workspace groups that can run long.
    const goTo = commandCategories.filter((c) => c.id === "go-to");
    const otherCommands = commandCategories.filter((c) => c.id !== "go-to");

    return [
      ...goTo,
      {
        id: "agents",
        heading: AGENTS_HEADING,
        visible: true,
        items: agentCommands.items,
      },
      ...workspaceCategories,
      {
        id: "run",
        heading: "Run",
        visible: customCommands.length > 0,
        items: customCommands,
      },
      ...otherCommands,
      {
        id: "linear",
        heading: "Linear",
        visible: linearItems.length > 0,
        items: linearItems,
      },
      {
        id: "github",
        heading: "GitHub",
        visible: githubItems.length > 0,
        items: githubItems,
      },
    ];
  }, [
    agentCommands,
    customCommands,
    scopedWorkspaceGroups,
    commandCategories,
    linearItems,
    githubItems,
  ]);

  // Pin the most-used commands above everything else. With an empty search box
  // these are the top few overall; while searching, the top few that match,
  // lifted out of their home groups so no command is listed twice. Each keeps
  // its home group's heading for matching, so searching a project name still
  // finds that project's frequent workspaces.
  const frequent = useMemo(() => {
    const byId = new Map<string, { item: CommandItem; heading: string }>();
    for (const cat of categories) {
      if (!cat.visible) continue;
      for (const item of cat.items) {
        byId.set(item.id, { item, heading: cat.heading });
      }
    }
    const items: CommandItem[] = [];
    const homeHeadings = new Map<string, string>();
    for (const id of rankCommandIds(commandUsage)) {
      const entry = byId.get(id);
      // Skip commands that no longer exist (closed workspace, finished task)
      // and no-ops like switching to the already-active workspace.
      if (!entry || entry.item.isActive) continue;
      if (
        search &&
        wordPrefixFilter(itemValue(entry.heading, entry.item), search) === 0
      ) {
        continue;
      }
      items.push(entry.item);
      homeHeadings.set(id, entry.heading);
      if (items.length >= FREQUENT_LIMIT) break;
    }
    return { items, homeHeadings };
  }, [search, categories, commandUsage]);

  const rootCategories = useMemo<CategoryConfig[]>(() => {
    if (frequent.items.length === 0) return categories;
    const pinned: CategoryConfig = {
      id: FREQUENT_CATEGORY_ID,
      heading: "Frequently Used",
      visible: true,
      items: frequent.items,
    };
    const rest = search
      ? categories.map((cat) => ({
          ...cat,
          items: cat.items.filter((item) => !frequent.homeHeadings.has(item.id)),
        }))
      : categories;
    return [pinned, ...rest];
  }, [frequent, categories, search]);

  // Project-owned rows outside the scope that match the query: the other
  // projects' workspace groups and agents. Drives the widening hints.
  const outOfScopeMatchCount = useMemo(() => {
    if (!scopeProjectId || !search) return 0;
    const matches = (heading: string, cmd: CommandItem) =>
      wordPrefixFilter(itemValue(heading, cmd), search) > 0;
    let count = 0;
    for (const group of workspaceGroups) {
      if (group.projectId === scopeProjectId) continue;
      for (const cmd of group.items) if (matches(group.heading, cmd)) count++;
    }
    for (const cmd of agentCommands.outOfScope) {
      if (matches(AGENTS_HEADING, cmd)) count++;
    }
    return count;
  }, [scopeProjectId, search, workspaceGroups, agentCommands.outOfScope]);

  // Whether the root view shows any row for the query (what cmdk's Empty
  // mirrors), for the footer's "+N in other projects" hint.
  const hasRootMatches = useMemo(
    () =>
      !search ||
      categories.some(
        (cat) =>
          cat.visible &&
          cat.items.some(
            (cmd) => wordPrefixFilter(itemValue(cat.heading, cmd), search) > 0,
          ),
      ),
    [categories, search],
  );

  const handleRootInputKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (view !== "root") return;
      if (e.nativeEvent.isComposing) return;
      if (e.key === "Backspace" && search === "" && scopeProjectId) {
        e.preventDefault();
        if (scopeArmed) widenScope();
        else setScopeArmed(true);
        return;
      }
      if (e.key === "Tab" && openedScopeProjectId) {
        e.preventDefault();
        setScopeProjectId((cur) => (cur ? null : openedScopeProjectId));
        setScopeArmed(false);
        listRef.current?.scrollTo(0, 0);
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && scopeProjectId) {
        // Stop cmdk from running the selected row.
        e.preventDefault();
        widenScope();
        return;
      }
      if (scopeArmed) setScopeArmed(false);
    },
    [view, search, scopeProjectId, scopeArmed, openedScopeProjectId, widenScope],
  );

  const scopeName = scopeProject?.name ?? null;
  const rootPlaceholder = scopeName
    ? `Search ${scopeName}…`
    : "Search all projects…";

  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            data-testid="command-palette"
            className={`${styles.palette} ${isDetailView ? styles.paletteWide : ""} ${view === "stats" ? styles.paletteStats : ""}`}
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
            <Command className={styles.command} loop filter={paletteFilter}>
              {isIssueListView && (
                <Row align="center" gap="xxs" className={styles.breadcrumb}>
                  <button
                    className={styles.breadcrumbBack}
                    onClick={navigateToRoot}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <span className={styles.breadcrumbLabel}>
                    {view === "linear-all" && "Linear — Tasks"}
                    {view === "github-all" && "GitHub — Tasks"}
                    {view === "processes" && "Processes"}
                    {view === "stats" && "Stats"}
                  </span>
                </Row>
              )}
              {view === "root" ? (
                <div className={styles.inputRow}>
                  <ScopeChip
                    projectName={scopeName}
                    armed={scopeArmed}
                    onClear={widenScope}
                  />
                  <Command.Input
                    ref={inputRef}
                    className={`${styles.input} ${styles.inputInRow}`}
                    placeholder={rootPlaceholder}
                    autoFocus
                    value={search}
                    onValueChange={(v) => {
                      setSearch(v);
                      setScopeArmed(false);
                      listRef.current?.scrollTo(0, 0);
                    }}
                    onKeyDown={handleRootInputKeyDown}
                  />
                </div>
              ) : (
                <Command.Input
                  className={styles.input}
                  placeholder={
                    isIssueListView ? "Search tasks..." : "Type a command..."
                  }
                  autoFocus
                  value={search}
                  onValueChange={(v) => {
                    setSearch(v);
                    listRef.current?.scrollTo(0, 0);
                  }}
                  style={
                    isDetailView ||
                    view === "processes" ||
                    view === "stats" ||
                    (isIssueListView && issueListEmpty)
                      ? { position: "absolute", opacity: 0, pointerEvents: "none", height: 0, padding: 0, border: "none" }
                      : undefined
                  }
                />
              )}
              <Command.List
                ref={listRef}
                className={styles.list}
                style={isDetailView ? HIDDEN_STYLE : undefined}
              >
                {view === "root" && (
                  <>
                    {rootCategories
                      .filter((c) => c.visible)
                      .sort((a, b) => {
                        if (!search) return 0;
                        // Frequently Used stays on top while searching.
                        if (a.id === FREQUENT_CATEGORY_ID) return -1;
                        if (b.id === FREQUENT_CATEGORY_ID) return 1;
                        
                        const bestScore = (cat: CategoryConfig) =>
                          Math.max(
                            0,
                            ...cat.items.map((cmd) => {
                              
                              return wordPrefixFilter(
                                itemValue(cat.heading, cmd),
                                search,
                              )
                            }),
                          );
                        return bestScore(b) - bestScore(a);
                      })
                      .map((cat, i) => (
                        <Fragment key={cat.id}>
                          {i > 0 && (
                            <Command.Separator className={styles.separator} />
                          )}
                          <Command.Group
                            heading={cat.heading}
                            className={styles.group}
                          >
                            {cat.items.map((cmd) => (
                              <Command.Item
                                key={cmd.id}
                                value={uniqueItemValue(
                                  cat.id === FREQUENT_CATEGORY_ID
                                    ? (frequent.homeHeadings.get(cmd.id) ??
                                        cat.heading)
                                    : cat.heading,
                                  cmd,
                                  cat.id,
                                )}
                                onSelect={() => {
                                  recordCommandUsage(cmd.id);
                                  cmd.action();
                                }}
                                className={`${styles.item} ${cmd.isActive ? styles.itemActive : ""}`}
                                keywords={
                                  cat.id === FREQUENT_CATEGORY_ID
                                    ? [...(cmd.keywords ?? []), FREQUENT_KEYWORD]
                                    : cmd.keywords
                                }
                              >
                                {cmd.icon && (
                                  <span className={styles.icon}>
                                    {cmd.icon}
                                  </span>
                                )}
                                <span className={styles.label}>
                                  {cmd.label}
                                </span>
                                {cmd.shortcut && (
                                  <span className={styles.shortcut}>
                                    {cmd.shortcut}
                                  </span>
                                )}
                                {cmd.isActive && (
                                  <span className={styles.activeBadge}>
                                    current
                                  </span>
                                )}
                                {cmd.suffix && (
                                  <span className={styles.chevron}>
                                    {cmd.suffix}
                                  </span>
                                )}
                              </Command.Item>
                            ))}
                          </Command.Group>
                        </Fragment>
                      ))}
                    {scopeName && outOfScopeMatchCount > 0 ? (
                      <Command.Empty
                        className={`${styles.emptyState} ${styles.scopedEmpty}`}
                        data-testid="palette-scope-empty"
                      >
                        <span className={styles.scopedEmptyTitle}>
                          No matches in <strong>{scopeName}</strong>.
                        </span>
                        <span className={styles.scopedEmptyHint}>
                          {outOfScopeMatchCount}{" "}
                          {outOfScopeMatchCount === 1 ? "match" : "matches"} in
                          other projects · <kbd className={styles.kbd}>⌫</kbd>{" "}
                          or <kbd className={styles.kbd}>{WIDEN_HINT}</kbd> to
                          search everywhere
                        </span>
                      </Command.Empty>
                    ) : (
                      <Command.Empty className={styles.emptyState}>
                        <span className={styles.emptyGhost} aria-hidden>
                          👻
                        </span>
                        <span className={styles.emptyTitle}>Boo!</span>
                        <span className={styles.emptyHint}>
                          No commands haunt this search.
                        </span>
                      </Command.Empty>
                    )}
                  </>
                )}

                {view === "linear-all" && (
                  <LinearIssuesView
                    allTeamIds={allTeamIds}
                    onEmptyChange={setIssueListEmpty}
                    onSelectIssue={(issueId) => {
                      setIssueListOrigin(view);
                      setSelectedIssueId(issueId);
                      setSearch("");
                      setView("issue-detail");
                    }}
                  />
                )}

                {view === "github-all" && repo && (
                  <GitHubIssuesView
                    repo={repo}
                    onEmptyChange={setIssueListEmpty}
                    onSelectIssue={(issueNumber) => {
                      setIssueListOrigin(view);
                      setSelectedGitHubIssueNumber(issueNumber);
                      setSearch("");
                      setView("github-issue-detail");
                    }}
                  />
                )}

                {view === "processes" && <ProcessesView />}

                {view === "stats" && <StatsView />}
              </Command.List>
              {view === "root" && scopeName && (
                <div className={styles.footer} data-testid="palette-scope-footer">
                  <span className={styles.footerItem}>
                    <kbd className={styles.kbd}>⌫</kbd> clear scope
                  </span>
                  {search && hasRootMatches && outOfScopeMatchCount > 0 && (
                    <span className={`${styles.footerItem} ${styles.footerRight}`}>
                      +{outOfScopeMatchCount} in other projects{" "}
                      <kbd className={styles.kbd}>{WIDEN_HINT}</kbd>
                    </span>
                  )}
                </div>
              )}
              {view === "processes" && (
                <KillAllFooter
                  onKillAll={async () => {
                    await window.electronAPI.processes.killAll();
                  }}
                />
              )}
              {view === "issue-detail" && selectedIssueId && (
                <IssueDetailView
                  issueId={selectedIssueId}
                  onBack={navigateBackToList}
                  onClose={handleClose}
                  onNewWorkspace={onNewWorkspace}
                  onNewAgentWithPrompt={onNewAgentWithPrompt}
                />
              )}
              {view === "github-issue-detail" &&
                selectedGitHubIssueNumber != null &&
                repo && (
                  <GitHubIssueDetailView
                    repo={repo}
                    issueNumber={selectedGitHubIssueNumber}
                    onBack={navigateBackToList}
                    onClose={handleClose}
                    onNewWorkspace={onNewWorkspace}
                    onNewAgentWithPrompt={onNewAgentWithPrompt}
                  />
                )}
            </Command>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
