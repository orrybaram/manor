import { useMemo, useCallback, useState, useRef, Fragment } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import { useAppStore, selectActiveWorkspace } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useWorkspaceCommands } from "./useWorkspaceCommands";
import { useCommands } from "./useCommands";
import { useTaskCommands } from "./useTaskCommands";
import { useCustomCommands } from "./useCustomCommands";
import { usePortsData } from "../ports/usePortsData";
import { LinearIcon } from "./LinearIcon";
import { GitHubIcon } from "./GitHubIcon";
import { LinearIssuesView } from "./LinearIssuesView";
import { GitHubIssuesView } from "./GitHubIssuesView";
import { IssueDetailView } from "./IssueDetailView";
import { GitHubIssueDetailView } from "./GitHubIssueDetailView";
import { ProcessesView, KillAllFooter } from "./ProcessesView";
import { GhostOverlay } from "./GhostOverlay";
import { wordPrefixFilter } from "./utils";
import type {
  CommandPaletteProps,
  PaletteView,
  CategoryConfig,
  CommandItem,
} from "./types";
import { Row } from "../ui/Layout/Layout";
import styles from "./CommandPalette.module.css";

const HIDDEN_STYLE = { display: "none" } as const;

export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose, onOpenSettings, onOpenFeedback, onNewWorkspace, onResumeTask, onViewAllTasks, onNewTask, onNewTaskWithPrompt, initialView, initialIssueId, initialGitHubIssueNumber } = props;

  const addTab = useAppStore((s) => s.addTab);
  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const selectNextTab = useAppStore((s) => s.selectNextTab);
  const selectPrevTab = useAppStore((s) => s.selectPrevTab);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const focusPrevPane = useAppStore((s) => s.focusPrevPane);
  const ws = useAppStore(selectActiveWorkspace);
  const tabs = useMemo(() => ws?.tabs ?? [], [ws?.tabs]);
  const selectedTabId = ws?.selectedTabId ?? null;
  const closeTab = useAppStore((s) => s.closeTab);
  const openOrFocusDiff = useAppStore((s) => s.openOrFocusDiff);
  const openDiffInNewPanel = useAppStore((s) => s.openDiffInNewPanel);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const projects = useProjectStore((s) => s.projects);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  const { ports } = usePortsData();
  const activePorts = useMemo(
    () => ports.filter((p) => p.workspacePath === activeWorkspacePath),
    [ports, activeWorkspacePath],
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
  const [showGhosts, setShowGhosts] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Derive the active project from the active workspace
  const activeProject = useMemo(
    () =>
      projects.find((p) =>
        p.workspaces.some((ws) => ws.path === activeWorkspacePath),
      ) ?? null,
    [projects, activeWorkspacePath],
  );

  // Get team IDs from the active project's Linear associations
  const allTeamIds = useMemo(
    () => (activeProject?.linearAssociations ?? []).map((a) => a.teamId),
    [activeProject],
  );

  // Derive repoPath from the active project
  const repoPath = activeProject?.path ?? null;

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
    onClose();
  }, [onClose]);

  const navigateToLinearAll = useCallback(() => {
    setSearch("");
    setView("linear-all");
  }, []);

  const navigateToGitHubAll = useCallback(() => {
    setSearch("");
    setView("github-all");
  }, []);

  const navigateToProcesses = useCallback(() => {
    setSearch("");
    setView("processes");
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
  });

  const commandCategories = useCommands({
    addTab,
    addBrowserTab,
    closePane,
    closeTab,
    splitPane,
    selectNextTab,
    selectPrevTab,
    focusNextPane,
    focusPrevPane,
    toggleSidebar,
    onClose: handleClose,
    onOpenSettings,
    onOpenFeedback,
    tabs,
    selectedTabId,
    setShowGhosts,
    activePorts,
    openOrFocusDiff,
    openDiffInNewPanel,
    navigateToProcesses,
  });

  const taskCommands = useTaskCommands({
    onResumeTask,
    onViewAllTasks,
    onClose: handleClose,
    onNewTask,
  });

  const customCommands = useCustomCommands({
    onClose: handleClose,
    activeWorkspacePath,
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

  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    // Focus the terminal in the currently focused pane, not just the first one in the DOM
    const state = useAppStore.getState();
    const path = state.activeWorkspacePath;
    const layout = path ? state.workspaceLayouts[path] : undefined;
    const panel = layout ? layout.panels[layout.activePanelId] : undefined;
    const tab = panel?.tabs.find((s) => s.id === panel?.selectedTabId);
    const focusedPaneId = tab?.focusedPaneId;
    if (focusedPaneId) {
      const paneEl = document.querySelector<HTMLElement>(`[data-pane-id="${focusedPaneId}"]`);
      const textarea = paneEl?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      if (textarea) {
        textarea.focus();
        return;
      }
    }
    // Fallback to any terminal
    document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
  }, []);

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
    },
    [view, navigateToRoot, navigateBackToList],
  );

  const showLinear = linearConnected && allTeamIds.length > 0;
  const showGitHub = githubConnected && !!repoPath;
  const isIssueListView =
    view === "linear-all" ||
    view === "github-all" ||
    view === "processes";
  const isDetailView =
    view === "issue-detail" || view === "github-issue-detail";

  const categories = useMemo<CategoryConfig[]>(() => {
    const workspaceCategories: CategoryConfig[] = [
      ...workspaceGroups.entries(),
    ].map(([groupName, items]) => ({
      id: `workspace-${groupName}`,
      heading: groupName,
      visible: true,
      items,
    }));

    const linearItems: CommandItem[] = [
      {
        id: "linear-issues",
        label: "Issues",
        icon: <LinearIcon size={14} />,
        suffix: <ChevronRight size={14} />,
        action: navigateToLinearAll,
      },
    ];

    const githubItems: CommandItem[] = [
      {
        id: "github-issues",
        label: "Issues",
        icon: <GitHubIcon size={14} />,
        suffix: <ChevronRight size={14} />,
        action: navigateToGitHubAll,
        keywords: ["ticket"],
      },
    ];

    return [
      { id: "tasks", heading: "Tasks", visible: true, items: taskCommands },
      ...workspaceCategories,
      {
        id: "run",
        heading: "Run",
        visible: customCommands.length > 0,
        items: customCommands,
      },
      ...commandCategories,
      {
        id: "linear",
        heading: "Linear",
        visible: showLinear,
        items: linearItems,
      },
      {
        id: "github",
        heading: "GitHub",
        visible: showGitHub,
        items: githubItems,
      },
    ];
  }, [
    taskCommands,
    customCommands,
    workspaceGroups,
    commandCategories,
    showLinear,
    showGitHub,
    navigateToLinearAll,
    navigateToGitHubAll,
  ]);


  return (
    <>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={`${styles.palette} ${isDetailView ? styles.paletteWide : ""}`}
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={handleCloseAutoFocus}
            onEscapeKeyDown={handleEscapeKeyDown}
          >
            <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
            <Command className={styles.command} loop filter={wordPrefixFilter}>
              {isIssueListView && (
                <Row align="center" gap="xxs" className={styles.breadcrumb}>
                  <button
                    className={styles.breadcrumbBack}
                    onClick={navigateToRoot}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <span className={styles.breadcrumbLabel}>
                    {view === "linear-all" && "Linear — Issues"}
                    {view === "github-all" && "GitHub — Issues"}
                    {view === "processes" && "Processes"}
                  </span>
                </Row>
              )}
              <Command.Input
                className={styles.input}
                placeholder={
                  isIssueListView ? "Search issues..." : "Type a command..."
                }
                autoFocus
                value={search}
                onValueChange={(v) => {
                  setSearch(v);
                  listRef.current?.scrollTo(0, 0);
                }}
                style={
                  isDetailView || view === "processes" || (isIssueListView && issueListEmpty)
                    ? { position: "absolute", opacity: 0, pointerEvents: "none", height: 0, padding: 0, border: "none" }
                    : undefined
                }
              />
              <Command.List
                ref={listRef}
                className={styles.list}
                style={isDetailView ? HIDDEN_STYLE : undefined}
              >
                {view === "root" && (
                  <>
                    {categories
                      .filter((c) => c.visible)
                      .sort((a, b) => {
                        if (!search) return 0;
                        
                        const bestScore = (cat: CategoryConfig) =>
                          Math.max(
                            0,
                            ...cat.items.map((cmd) => {
                              
                              return wordPrefixFilter(
                                `${cat.heading} ${cmd.label} ${cmd.keywords?.join(" ") ?? ""}`,
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
                                value={`${cat.heading} ${cmd.label} ${cmd.keywords?.join(" ") ?? ""}`}
                                onSelect={cmd.action}
                                className={`${styles.item} ${cmd.isActive ? styles.itemActive : ""}`}
                                keywords={cmd.keywords}
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

                {view === "github-all" && repoPath && (
                  <GitHubIssuesView
                    repoPath={repoPath}
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
              </Command.List>
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
                  onNewTaskWithPrompt={onNewTaskWithPrompt}
                />
              )}
              {view === "github-issue-detail" &&
                selectedGitHubIssueNumber != null &&
                repoPath && (
                  <GitHubIssueDetailView
                    repoPath={repoPath}
                    issueNumber={selectedGitHubIssueNumber}
                    onBack={navigateBackToList}
                    onClose={handleClose}
                    onNewWorkspace={onNewWorkspace}
                    onNewTaskWithPrompt={onNewTaskWithPrompt}
                  />
                )}
            </Command>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {showGhosts && <GhostOverlay />}
    </>
  );
}
