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
import { LinearIssuesView } from "./LinearIssuesView";
import { IssueDetailView } from "./IssueDetailView";
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
  const zoomIn = useAppStore((s) => s.zoomIn);
  const zoomOut = useAppStore((s) => s.zoomOut);
  const resetZoom = useAppStore((s) => s.resetZoom);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const projects = useProjectStore((s) => s.projects);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);

  const [view, setView] = useState<PaletteView>("root");
  const [search, setSearch] = useState("");
  const [linearConnected, setLinearConnected] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
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

  // Check Linear connection status when palette opens
  useEffect(() => {
    if (!open) return;
    window.electronAPI.linear
      .isConnected()
      .then(setLinearConnected)
      .catch(() => setLinearConnected(false));
  }, [open]);

  // Reset state when palette closes
  useEffect(() => {
    if (!open) {
      setView("root");
      setSearch("");
      setSelectedIssueId(null);
    }
  }, [open]);

  const navigateToLinear = useCallback(() => {
    setSearch("");
    setView("linear");
  }, []);

  const navigateToRoot = useCallback(() => {
    setSearch("");
    setSelectedIssueId(null);
    setView("root");
  }, []);

  const navigateToLinearList = useCallback(() => {
    setSearch("");
    setSelectedIssueId(null);
    setView("linear");
  }, []);

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
    zoomIn,
    zoomOut,
    resetZoom,
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
      if (view === "issue-detail") {
        e.preventDefault();
        navigateToLinearList();
        return;
      }
      if (view !== "root") {
        e.preventDefault();
        navigateToRoot();
        return;
      }
    },
    [view, navigateToRoot, navigateToLinearList],
  );

  const showLinear = linearConnected && allTeamIds.length > 0;

  return (
    <>
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={`${styles.palette} ${view === "issue-detail" ? styles.paletteWide : ""}`}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
          onEscapeKeyDown={handleEscapeKeyDown}
        >
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          <Command className={styles.command} loop filter={wordPrefixFilter}>
            {view === "linear" && (
              <div className={styles.breadcrumb}>
                <button
                  className={styles.breadcrumbBack}
                  onClick={navigateToRoot}
                >
                  <ArrowLeft size={14} />
                </button>
                <span className={styles.breadcrumbLabel}>Linear Issues</span>
              </div>
            )}
            {view !== "issue-detail" && (
              <Command.Input
                className={styles.input}
                placeholder={
                  view === "linear" ? "Search issues..." : "Type a command..."
                }
                autoFocus
                value={search}
                onValueChange={setSearch}
              />
            )}
            <Command.List className={styles.list} style={view === "issue-detail" ? HIDDEN_STYLE : undefined}>
              {view === "linear" && (
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
                          value="Linear Issues"
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
                      </Command.Group>
                    </>
                  )}
                </>
              )}

              {view === "linear" && (
                <LinearIssuesView
                  allTeamIds={allTeamIds}
                  onSelectIssue={(issueId) => {
                    setSelectedIssueId(issueId);
                    setSearch("");
                    setView("issue-detail");
                  }}
                />
              )}
            </Command.List>
            {view === "issue-detail" && selectedIssueId && (
              <IssueDetailView
                issueId={selectedIssueId}
                onBack={navigateToLinearList}
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
