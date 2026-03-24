import {
  useMemo,
  useCallback,
  useState,
  useEffect,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useWorkspaceCommands } from "./useWorkspaceCommands";
import { useCommands } from "./useCommands";
import { useTaskCommands } from "./useTaskCommands";
import { LinearIcon } from "./LinearIcon";
import { GitHubIcon } from "./GitHubIcon";
import { LinearIssuesView } from "./LinearIssuesView";
import { GitHubIssuesView } from "./GitHubIssuesView";
import { IssueDetailView } from "./IssueDetailView";
import { GitHubIssueDetailView } from "./GitHubIssueDetailView";
import { GhostOverlay } from "./GhostOverlay";
import { wordPrefixFilter } from "./utils";
import type { CommandPaletteProps, PaletteView } from "./types";
import styles from "./CommandPalette.module.css";

const HIDDEN_STYLE = { display: "none" } as const;

export function CommandPalette({
  open,
  onClose,
  onOpenSettings,
  onNewWorkspace,
  onResumeTask,
  onViewAllTasks,
  onNewTask,
}: CommandPaletteProps) {
  const addSession = useAppStore((s) => s.addSession);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const selectNextSession = useAppStore((s) => s.selectNextSession);
  const selectPrevSession = useAppStore((s) => s.selectPrevSession);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const focusPrevPane = useAppStore((s) => s.focusPrevPane);
  const ws = useAppStore(selectActiveWorkspace);
  const sessions = useMemo(() => ws?.sessions ?? [], [ws?.sessions]);
  const selectedSessionId = ws?.selectedSessionId ?? null;
  const closeSession = useAppStore((s) => s.closeSession);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const projects = useProjectStore((s) => s.projects);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  const [view, setView] = useState<PaletteView>("root");
  const [search, setSearch] = useState("");
  const [linearConnected, setLinearConnected] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedGitHubIssueNumber, setSelectedGitHubIssueNumber] = useState<number | null>(null);
  const [issueListOrigin, setIssueListOrigin] = useState<PaletteView>("linear");
  const [showGhosts, setShowGhosts] = useState(false);

  // Get all team IDs from projects with Linear associations
  const allTeamIds = useMemo(() => {
    const ids = new Set<string>();
    for (const project of projects) {
      for (const assoc of project.linearAssociations) {
        ids.add(assoc.teamId);
      }
    }
    return [...ids];
  }, [projects]);

  // Derive repoPath from the active project
  const repoPath = useMemo(() => {
    const project = projects.find((p) =>
      p.workspaces.some((ws) => ws.path === activeWorkspacePath),
    );
    return project?.path ?? null;
  }, [projects, activeWorkspacePath]);

  // Check connection status when palette opens
  useEffect(() => {
    if (!open) return;
    window.electronAPI.linear
      .isConnected()
      .then(setLinearConnected)
      .catch(() => setLinearConnected(false));
    window.electronAPI.github
      .checkStatus()
      .then((s) => setGithubConnected(s.installed && s.authenticated))
      .catch(() => setGithubConnected(false));
  }, [open]);

  // Reset state when palette closes
  useEffect(() => {
    if (!open) {
      setView("root");
      setSearch("");
      setSelectedIssueId(null);
      setSelectedGitHubIssueNumber(null);
    }
  }, [open]);

  const navigateToLinear = useCallback(() => {
    setSearch("");
    setView("linear");
  }, []);

  const navigateToLinearAll = useCallback(() => {
    setSearch("");
    setView("linear-all");
  }, []);

  const navigateToGitHub = useCallback(() => {
    setSearch("");
    setView("github");
  }, []);

  const navigateToGitHubAll = useCallback(() => {
    setSearch("");
    setView("github-all");
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
    setActiveWorkspace,
    onClose,
    onNewWorkspace,
  });

  const commands = useCommands({
    addSession,
    closePane,
    closeSession,
    splitPane,
    selectNextSession,
    selectPrevSession,
    focusNextPane,
    focusPrevPane,
    toggleSidebar,
    onClose,
    onOpenSettings,
    sessions,
    selectedSessionId,
    setShowGhosts,
  });

  const taskCommands = useTaskCommands({
    onResumeTask,
    onViewAllTasks,
    onClose,
    onNewTask,
  });

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose],
  );

  const handleOpenAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
  }, []);

  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    textarea?.focus();
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
  const isIssueListView = view === "linear" || view === "linear-all" || view === "github" || view === "github-all";
  const isDetailView = view === "issue-detail" || view === "github-issue-detail";

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
              <div className={styles.breadcrumb}>
                <button
                  className={styles.breadcrumbBack}
                  onClick={navigateToRoot}
                >
                  <ArrowLeft size={14} />
                </button>
                <span className={styles.breadcrumbLabel}>
                  {view === "linear" && "Linear — My Issues"}
                  {view === "linear-all" && "Linear — All Issues"}
                  {view === "github" && "GitHub — My Issues"}
                  {view === "github-all" && "GitHub — All Issues"}
                </span>
              </div>
            )}
            {!isDetailView && (
              <Command.Input
                className={styles.input}
                placeholder={
                  isIssueListView ? "Search issues..." : "Type a command..."
                }
                autoFocus
                value={search}
                onValueChange={setSearch}
              />
            )}
            <Command.List className={styles.list} style={isDetailView ? HIDDEN_STYLE : undefined}>
              {isIssueListView && (
                <Command.Empty className={styles.empty}>
                  No matching issues
                </Command.Empty>
              )}

              {view === "root" && (
                <>
                  <Command.Group heading="Tasks" className={styles.group}>
                    {taskCommands.map((cmd) => (
                      <Command.Item
                        key={cmd.id}
                        value={cmd.label}
                        onSelect={cmd.action}
                        className={styles.item}
                      >
                        {cmd.icon && (
                          <span className={styles.icon}>{cmd.icon}</span>
                        )}
                        <span className={styles.label}>{cmd.label}</span>
                        {cmd.shortcut && (
                          <span className={styles.shortcut}>
                            {cmd.shortcut}
                          </span>
                        )}
                      </Command.Item>
                    ))}
                  </Command.Group>
                  <Command.Separator className={styles.separator} />
                  {[...workspaceGroups.entries()].map(([groupName, items]) => (
                    <Command.Group
                      key={groupName}
                      heading={groupName}
                      className={styles.group}
                    >
                      {items.map((cmd) => (
                        <Command.Item
                          key={cmd.id}
                          value={`${groupName} ${cmd.label}`}
                          onSelect={cmd.action}
                          className={`${styles.item} ${cmd.isActive ? styles.itemActive : ""}`}
                        >
                          {cmd.icon && (
                            <span className={styles.icon}>{cmd.icon}</span>
                          )}
                          <span className={styles.label}>{cmd.label}</span>
                          {cmd.isActive && (
                            <span className={styles.activeBadge}>current</span>
                          )}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  ))}
                  <Command.Separator className={styles.separator} />
                  <Command.Group heading="Commands" className={styles.group}>
                    {commands.map((cmd) => (
                      <Command.Item
                        key={cmd.id}
                        value={cmd.label}
                        onSelect={cmd.action}
                        className={styles.item}
                      >
                        {cmd.icon && (
                          <span className={styles.icon}>{cmd.icon}</span>
                        )}
                        <span className={styles.label}>{cmd.label}</span>
                        {cmd.shortcut && (
                          <span className={styles.shortcut}>
                            {cmd.shortcut}
                          </span>
                        )}
                      </Command.Item>
                    ))}
                  </Command.Group>
                  {showLinear && (
                    <>
                      <Command.Separator className={styles.separator} />
                      <Command.Group heading="Linear" className={styles.group}>
                        <Command.Item
                          value="Linear My Issues"
                          onSelect={navigateToLinear}
                          className={styles.item}
                        >
                          <span className={styles.icon}>
                            <LinearIcon size={14} />
                          </span>
                          <span className={styles.label}>My Issues</span>
                          <span className={styles.chevron}>
                            <ChevronRight size={14} />
                          </span>
                        </Command.Item>
                        <Command.Item
                          value="Linear All Issues"
                          onSelect={navigateToLinearAll}
                          className={styles.item}
                        >
                          <span className={styles.icon}>
                            <LinearIcon size={14} />
                          </span>
                          <span className={styles.label}>All Issues</span>
                          <span className={styles.chevron}>
                            <ChevronRight size={14} />
                          </span>
                        </Command.Item>
                      </Command.Group>
                    </>
                  )}
                  {showGitHub && (
                    <>
                      <Command.Separator className={styles.separator} />
                      <Command.Group heading="GitHub" className={styles.group}>
                        <Command.Item
                          value="GitHub My Issues"
                          onSelect={navigateToGitHub}
                          className={styles.item}
                        >
                          <span className={styles.icon}>
                            <GitHubIcon size={14} />
                          </span>
                          <span className={styles.label}>My Issues</span>
                          <span className={styles.chevron}>
                            <ChevronRight size={14} />
                          </span>
                        </Command.Item>
                        <Command.Item
                          value="GitHub All Issues"
                          onSelect={navigateToGitHubAll}
                          className={styles.item}
                        >
                          <span className={styles.icon}>
                            <GitHubIcon size={14} />
                          </span>
                          <span className={styles.label}>All Issues</span>
                          <span className={styles.chevron}>
                            <ChevronRight size={14} />
                          </span>
                        </Command.Item>
                      </Command.Group>
                    </>
                  )}
                </>
              )}

              {(view === "linear" || view === "linear-all") && (
                <LinearIssuesView
                  allTeamIds={allTeamIds}
                  allIssues={view === "linear-all"}
                  onSelectIssue={(issueId) => {
                    setIssueListOrigin(view);
                    setSelectedIssueId(issueId);
                    setSearch("");
                    setView("issue-detail");
                  }}
                />
              )}

              {(view === "github" || view === "github-all") && repoPath && (
                <GitHubIssuesView
                  repoPath={repoPath}
                  allIssues={view === "github-all"}
                  onSelectIssue={(issueNumber) => {
                    setIssueListOrigin(view);
                    setSelectedGitHubIssueNumber(issueNumber);
                    setSearch("");
                    setView("github-issue-detail");
                  }}
                />
              )}
            </Command.List>
            {view === "issue-detail" && selectedIssueId && (
              <IssueDetailView
                issueId={selectedIssueId}
                onBack={navigateBackToList}
                onClose={onClose}
                onNewWorkspace={onNewWorkspace}
              />
            )}
            {view === "github-issue-detail" && selectedGitHubIssueNumber != null && repoPath && (
              <GitHubIssueDetailView
                repoPath={repoPath}
                issueNumber={selectedGitHubIssueNumber}
                onBack={navigateBackToList}
                onClose={onClose}
                onNewWorkspace={onNewWorkspace}
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
