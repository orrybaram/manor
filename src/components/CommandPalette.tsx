import {
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import {
  House,
  FolderGit2,
  Plus,
  ChevronRight,
  ArrowLeft,
  GitBranch,
  ExternalLink,
  Loader2,
  Clock,
} from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import type { RecentView } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import type { LinearIssue } from "../electron.d";
import styles from "./CommandPalette.module.css";

interface CommandItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  group?: string;
  isActive?: boolean;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
  onNewWorkspace?: (opts?: {
    projectId?: string;
    name?: string;
    branch?: string;
  }) => void;
}

type PaletteView = "root" | "linear";

export function CommandPalette({
  open,
  onClose,
  onOpenSettings,
  onNewWorkspace,
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
  const recentViews = useAppStore((s) => s.recentViews);
  const selectSession = useAppStore((s) => s.selectSession);
  const paneTitle = useAppStore((s) => s.paneTitle);
  const paneCwd = useAppStore((s) => s.paneCwd);

  const [view, setView] = useState<PaletteView>("root");
  const [search, setSearch] = useState("");
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([]);
  const [linearLoading, setLinearLoading] = useState(false);
  const [linearConnected, setLinearConnected] = useState(false);
  const [popoverIssue, setPopoverIssue] = useState<LinearIssue | null>(null);
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null);

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
    window.electronAPI
      .linearIsConnected()
      .then(setLinearConnected)
      .catch(() => setLinearConnected(false));
  }, [open]);

  // Fetch Linear issues when entering Linear view
  useEffect(() => {
    if (view !== "linear" || allTeamIds.length === 0) return;

    let cancelled = false;
    setLinearLoading(true);
    window.electronAPI
      .linearGetMyIssues(allTeamIds, {
        stateTypes: ["unstarted", "backlog"],
        limit: 50,
      })
      .then((issues) => {
        if (!cancelled) setLinearIssues(issues);
      })
      .catch((err) => {
        console.error("[CommandPalette] Failed to fetch Linear issues:", err);
      })
      .finally(() => {
        if (!cancelled) setLinearLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [view, allTeamIds]);

  // Reset state when palette closes
  useEffect(() => {
    if (!open) {
      setView("root");
      setSearch("");
      setPopoverIssue(null);
    }
  }, [open]);

  const navigateToLinear = useCallback(() => {
    setSearch("");
    setView("linear");
  }, []);

  const navigateToRoot = useCallback(() => {
    setSearch("");
    setPopoverIssue(null);
    setView("root");
  }, []);

  // Find the project that has a Linear association for a given issue's team
  const findProjectForIssue = useCallback(
    (_issue: LinearIssue) => {
      // Return the first project that has any Linear association
      // (issues are already filtered by team IDs from associated projects)
      return projects.find((p) => p.linearAssociations.length > 0);
    },
    [projects],
  );

  const handleCreateWorkspace = useCallback(
    (issue: LinearIssue) => {
      const project = findProjectForIssue(issue);
      if (!project) return;

      // Check if a workspace with matching branch already exists
      const current = useProjectStore
        .getState()
        .projects.find((p) => p.id === project.id);
      const existingIdx =
        current?.workspaces.findIndex(
          (ws) => ws.branch === issue.branchName,
        ) ?? -1;
      if (existingIdx >= 0) {
        selectWorkspace(project.id, existingIdx);
        const existingWs = current?.workspaces[existingIdx];
        if (existingWs) setActiveWorkspace(existingWs.path);
        onClose();
        return;
      }

      // Open the new workspace dialog with pre-filled info
      onClose();
      onNewWorkspace?.({
        projectId: project.id,
        name: issue.title,
        branch: issue.branchName,
      });
    },
    [
      findProjectForIssue,
      selectWorkspace,
      setActiveWorkspace,
      onClose,
      onNewWorkspace,
    ],
  );

  const handleOpenInBrowser = useCallback(
    (issue: LinearIssue) => {
      window.electronAPI.openExternal(issue.url);
      onClose();
    },
    [onClose],
  );

  const workspaceCommands: CommandItem[] = useMemo(() => {
    const cmds: CommandItem[] = [];
    for (const project of projects) {
      for (let wi = 0; wi < project.workspaces.length; wi++) {
        const workspace = project.workspaces[wi];
        const isActive = workspace.path === activeWorkspacePath;
        const displayName = workspace.name || workspace.branch || "main";
        cmds.push({
          id: `ws-${project.id}-${wi}`,
          label: displayName,
          icon: workspace.isMain ? (
            <House size={14} />
          ) : (
            <FolderGit2 size={14} />
          ),
          group: project.name,
          isActive,
          action: () => {
            if (!isActive) {
              selectWorkspace(project.id, wi);
              setActiveWorkspace(workspace.path);
            }
            onClose();
          },
        });
      }
      cmds.push({
        id: `new-ws-${project.id}`,
        label: "New Workspace",
        icon: <Plus size={14} />,
        group: project.name,
        action: () => {
          onNewWorkspace?.({ projectId: project.id });
          onClose();
        },
      });
    }
    return cmds;
  }, [
    projects,
    activeWorkspacePath,
    selectWorkspace,
    setActiveWorkspace,
    onClose,
    onNewWorkspace,
  ]);

  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: "new-session",
        label: "New Session",
        shortcut: "⌘T",
        action: () => {
          addSession();
          onClose();
        },
      },
      {
        id: "close-pane",
        label: "Close Pane",
        shortcut: "⌘W",
        action: () => {
          closePane();
          onClose();
        },
      },
      {
        id: "close-session",
        label: "Close Session",
        shortcut: "⌘⇧W",
        action: () => {
          const session = sessions.find((s) => s.id === selectedSessionId);
          if (session) closeSession(session.id);
          onClose();
        },
      },
      {
        id: "split-h",
        label: "Split Horizontal",
        shortcut: "⌘D",
        action: () => {
          splitPane("horizontal");
          onClose();
        },
      },
      {
        id: "split-v",
        label: "Split Vertical",
        shortcut: "⌘⇧D",
        action: () => {
          splitPane("vertical");
          onClose();
        },
      },
      {
        id: "next-session",
        label: "Next Session",
        shortcut: "⌘⇧]",
        action: () => {
          selectNextSession();
          onClose();
        },
      },
      {
        id: "prev-session",
        label: "Previous Session",
        shortcut: "⌘⇧[",
        action: () => {
          selectPrevSession();
          onClose();
        },
      },
      {
        id: "next-pane",
        label: "Next Pane",
        shortcut: "⌘]",
        action: () => {
          focusNextPane();
          onClose();
        },
      },
      {
        id: "prev-pane",
        label: "Previous Pane",
        shortcut: "⌘[",
        action: () => {
          focusPrevPane();
          onClose();
        },
      },
      {
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        shortcut: "⌘\\",
        action: () => {
          toggleSidebar();
          onClose();
        },
      },
      {
        id: "zoom-in",
        label: "Zoom In",
        shortcut: "⌘=",
        action: () => {
          zoomIn();
          onClose();
        },
      },
      {
        id: "zoom-out",
        label: "Zoom Out",
        shortcut: "⌘-",
        action: () => {
          zoomOut();
          onClose();
        },
      },
      {
        id: "zoom-reset",
        label: "Reset Zoom",
        shortcut: "⌘0",
        action: () => {
          resetZoom();
          onClose();
        },
      },
      {
        id: "settings",
        label: "Settings",
        shortcut: "⌘,",
        action: () => {
          onOpenSettings?.();
          onClose();
        },
      },
    ],
    [
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
    ],
  );

  // Group workspace commands by project name, active project first
  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, CommandItem[]>();
    for (const cmd of workspaceCommands) {
      const group = cmd.group || "Workspaces";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(cmd);
    }
    const sorted = [...groups.entries()].sort(([, a], [, b]) => {
      const aActive = a.some((c) => c.isActive) ? 0 : 1;
      const bActive = b.some((c) => c.isActive) ? 0 : 1;
      return aActive - bActive;
    });
    return new Map(sorted);
  }, [workspaceCommands]);

  // Build recent view commands from tracked views
  const recentCommands: CommandItem[] = useMemo(() => {
    const allWorkspaceSessions = useAppStore.getState().workspaceSessions;
    return recentViews
      .filter(
        (rv: RecentView) =>
          !(
            rv.workspacePath === activeWorkspacePath &&
            rv.sessionId === selectedSessionId
          ),
      )
      .map((rv: RecentView) => {
        const ws = allWorkspaceSessions[rv.workspacePath];
        if (!ws) return null;
        const session = ws.sessions.find((s) => s.id === rv.sessionId);
        if (!session) return null;
        // Find workspace display name from projects
        const project = projects.find((p) =>
          p.workspaces.some((w) => w.path === rv.workspacePath),
        );
        const workspace = project?.workspaces.find(
          (w) => w.path === rv.workspacePath,
        );
        const wsName = workspace?.name || workspace?.branch || "main";
        const projectName = project?.name ?? "";
        const paneId = session.focusedPaneId;
        const label =
          paneTitle[paneId] ||
          paneCwd[paneId]?.split("/").pop() ||
          session.title;
        return {
          id: `recent-${rv.sessionId}`,
          label,
          icon: <Clock size={14} />,
          group: `${projectName} / ${wsName}`,
          action: () => {
            if (rv.workspacePath !== activeWorkspacePath) {
              const wi =
                project?.workspaces.findIndex(
                  (w) => w.path === rv.workspacePath,
                ) ?? -1;
              if (project && wi >= 0) {
                selectWorkspace(project.id, wi);
                setActiveWorkspace(rv.workspacePath);
              }
            }
            selectSession(rv.sessionId);
            onClose();
          },
        } satisfies CommandItem;
      })
      .filter(Boolean) as CommandItem[];
  }, [
    recentViews,
    projects,
    activeWorkspacePath,
    selectedSessionId,
    selectWorkspace,
    setActiveWorkspace,
    selectSession,
    onClose,
    paneTitle,
    paneCwd,
  ]);

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
      if (popoverIssue) {
        e.preventDefault();
        setPopoverIssue(null);
        return;
      }
      if (view !== "root") {
        e.preventDefault();
        navigateToRoot();
        return;
      }
    },
    [view, popoverIssue, navigateToRoot],
  );

  const showLinear = linearConnected && allTeamIds.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.palette}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
          onEscapeKeyDown={handleEscapeKeyDown}
        >
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          <Command className={styles.command} loop>
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
            <Command.Input
              className={styles.input}
              placeholder={
                view === "linear" ? "Search issues..." : "Type a command..."
              }
              autoFocus
              value={search}
              onValueChange={setSearch}
            />
            <Command.List className={styles.list}>
              <Command.Empty className={styles.empty}>
                {view === "linear"
                  ? "No matching issues"
                  : "No matching commands"}
              </Command.Empty>

              {view === "root" && (
                <>
                  {recentCommands.length > 0 && (
                    <>
                      <Command.Group heading="Recent" className={styles.group}>
                        {recentCommands.map((cmd) => (
                          <Command.Item
                            key={cmd.id}
                            value={`Recent ${cmd.group} ${cmd.label} ${cmd.id}`}
                            onSelect={cmd.action}
                            className={styles.item}
                          >
                            {cmd.icon && (
                              <span className={styles.icon}>{cmd.icon}</span>
                            )}
                            <span className={styles.label}>{cmd.label}</span>
                            <span className={styles.recentMeta}>
                              {cmd.group}
                            </span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                      <Command.Separator className={styles.separator} />
                    </>
                  )}
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
                <>
                  {linearLoading ? (
                    <div className={styles.linearLoading}>
                      <Loader2 size={16} className={styles.spinner} />
                      <span>Loading issues...</span>
                    </div>
                  ) : (
                    <Command.Group heading="My Issues" className={styles.group}>
                      {linearIssues.map((issue) => (
                        <Popover.Root
                          key={issue.id}
                          open={popoverIssue?.id === issue.id}
                          onOpenChange={(isOpen) => {
                            if (!isOpen) setPopoverIssue(null);
                          }}
                        >
                          <Popover.Anchor asChild>
                            <div
                              ref={
                                popoverIssue?.id === issue.id
                                  ? popoverAnchorRef
                                  : undefined
                              }
                            >
                              <Command.Item
                                value={`${issue.identifier} ${issue.title}`}
                                onSelect={() => setPopoverIssue(issue)}
                                className={styles.item}
                              >
                                <span className={styles.issueIdentifier}>
                                  {issue.identifier}
                                </span>
                                <span className={styles.label}>
                                  {issue.title}
                                </span>
                                <span className={styles.issueState}>
                                  {issue.state.name}
                                </span>
                              </Command.Item>
                            </div>
                          </Popover.Anchor>
                          <Popover.Portal>
                            <Popover.Content
                              className={styles.issuePopover}
                              side="right"
                              sideOffset={8}
                              align="start"
                              onCloseAutoFocus={(e) => e.preventDefault()}
                              onKeyDown={(e) => {
                                // Stop all key events from bubbling to cmdk
                                e.stopPropagation();
                                if (
                                  e.key === "ArrowDown" ||
                                  e.key === "ArrowUp"
                                ) {
                                  e.preventDefault();
                                  const container = e.currentTarget;
                                  const buttons = Array.from(
                                    container.querySelectorAll<HTMLButtonElement>(
                                      "button:not(:disabled)",
                                    ),
                                  );
                                  const idx = buttons.indexOf(
                                    e.target as HTMLButtonElement,
                                  );
                                  const next =
                                    e.key === "ArrowDown"
                                      ? buttons[(idx + 1) % buttons.length]
                                      : buttons[
                                          (idx - 1 + buttons.length) %
                                            buttons.length
                                        ];
                                  next?.focus();
                                }
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  setPopoverIssue(null);
                                  requestAnimationFrame(() => {
                                    const input =
                                      document.querySelector<HTMLInputElement>(
                                        "[cmdk-input]",
                                      );
                                    input?.focus();
                                  });
                                }
                              }}
                            >
                              <button
                                className={styles.popoverAction}
                                onClick={() => handleCreateWorkspace(issue)}
                              >
                                <GitBranch size={14} />
                                <span>Create Workspace</span>
                              </button>
                              <button
                                className={styles.popoverAction}
                                onClick={() => handleOpenInBrowser(issue)}
                              >
                                <ExternalLink size={14} />
                                <span>Open in Browser</span>
                              </button>
                            </Popover.Content>
                          </Popover.Portal>
                        </Popover.Root>
                      ))}
                    </Command.Group>
                  )}
                </>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LinearIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="currentColor">
      <path d="M1.22541 61.5228c-.97401-5.7278-.97401-11.4256 0-17.0455l.07685-.4518c.10143-.5954.35796-1.1517.74457-1.6151l14.77537-17.7111c.7399-.8868 1.9249-1.2862 3.0621-.9884 4.5856 1.1998 8.7456 3.5456 12.1602 6.8503l.0769.0744c3.4058 3.4059 5.7411 7.5542 6.9411 12.1307.2979 1.1372-.1015 2.3223-.9883 3.0621l-17.7111 14.7754c-.4634.3866-1.0197.6431-1.6152.7446l-.4518.0768c-5.7199.9741-11.4177.9741-17.0455 0l-.0256-.0044z" />
      <path d="M30.7395 9.54529c.9042-.41368 1.9576-.30498 2.7471.28313l16.0355 11.94798c.7895.5881 1.1739 1.5664.997 2.5346l-.0274.1497c-.1862 1.0182-.9244 1.8532-1.9062 2.1548-3.9562 1.2148-7.5721 3.3389-10.5743 6.2087l-.0744.0712c-3.0024 2.8698-5.1265 6.4857-6.3413 10.4419-.3017.9818-1.1366 1.72-2.1548 1.9062l-.1497.0274c-.9682.177-1.9466-.2075-2.5346-.997L14.8223 28.0888c-.5881-.7895-.697-1.8429-.2834-2.7471C18.053 17.2523 23.6501 12.0596 30.7395 9.54529z" />
      <path d="M61.5765 1.30044c5.6862-.96715 11.3403-.96715 17.0265 0l.4518.07685c.5954.10143 1.1517.35796 1.6151.74457l17.7111 14.77534c.8868.7399 1.2862 1.925.9884 3.0621-1.1998 4.5856-3.5456 8.7456-6.8503 12.1602l-.0744.0769c-3.4059 3.4059-7.5542 5.7411-12.1307 6.9411-1.1372.2979-2.3223-.1015-3.0621-.9883L62.477 20.4377c-.3866-.4634-.6431-1.0197-.7446-1.6151l-.0768-.4518c-.9741-5.7199-.9741-11.4177 0-17.0455l.0044-.0256-.0835.0006z" />
      <path d="M90.4547 30.7395c.4137.9042.305 1.9576-.2831 2.7471L78.2237 49.527c-.5881.7895-1.5664 1.1739-2.5346.997l-.1498-.0274c-1.0181-.1862-1.8531-.9244-2.1547-1.9062-1.2149-3.9562-3.339-7.5721-6.2088-10.5743l-.0712-.0744c-2.8698-3.0024-6.4857-5.1265-10.4419-6.3413-.9818-.3016-1.72-1.1366-1.9062-2.1548l-.0274-.1497c-.177-.9682.2075-1.9466.997-2.5346l11.948-16.0355c.7895-.58811 1.8429-.69701 2.7471-.28313 8.0894 3.5143 13.6865 9.1114 17.201 17.201l-.0685.0137z" />
      <path d="M97.6746 57.4783c1.3005 3.7148 1.8399 7.4624 1.7384 11.2028-.0352 1.2987-.9882 2.3831-2.2602 2.5725l-20.5467 3.0564c-1.2921.1921-2.556-.4406-3.1903-1.5797l-.0015-.0025c-.6396-1.1484-.5485-2.5484.2308-3.6088l14.5816-19.8423c.7694-1.0471 2.0789-1.5299 3.3162-1.2171 3.5879.9067 6.442 4.0485 6.1317 9.4187z" />
      <path d="M57.4783 97.6746c3.7148 1.3005 7.4624 1.8399 11.2028 1.7384 1.2987-.0352 2.3831-.9882 2.5725-2.2602l3.0564-20.5467c.1921-1.2921-.4406-2.556-1.5797-3.1903l-.0025-.0015c-1.1484-.6396-2.5484-.5485-3.6088.2308l-19.8423 14.5816c-1.0471.7694-1.5299 2.0789-1.2171 3.3162.9067 3.5879 4.0485 6.442 9.4187 6.1317z" />
      <path d="M98.7746 38.4224c.746 2.6568.746 5.3136 0 7.9704l-.0363.2134c-.0724.4244-.2508.8208-.5178 1.1517l-10.8539 13.4536c-.5629.6979-1.4502.9933-2.3153.7266-2.1968-.6774-4.3281-.6269-6.3831.2004-.5959.2398-1.2673.2045-1.8336-.0964l-.0024-.0013c-.5663-.301-.9717-.8334-1.1074-1.4533l-3.4693-15.8557c-.0891-.4071-.0535-.8316.1026-1.2189l.0014-.0034c.2422-.6006.7338-1.0631 1.3476-1.2674l15.8438-5.279c.6138-.2044 1.286-.1448 1.8576.1608 2.5084 1.3422 4.4399 1.5222 5.7696.1437.3333-.3456.7551-.5814 1.2188-.6819l.2134-.0363c2.6568-.746 5.3136-.746 7.9705 0l-.0005.0005-.0157-.0004z" />
      <path d="M38.4224 98.7746c2.6568.746 5.3136.746 7.9704 0l.2134-.0363c.4244-.0724.8208-.2508 1.1517-.5178l13.4536-10.8539c.6979-.5629.9933-1.4502.7266-2.3153-.6774-2.1968-.6269-4.3281.2004-6.3831.2398-.5959.2045-1.2673-.0964-1.8336l-.0012-.0024c-.301-.5663-.8335-.9717-1.4534-1.1074l-15.8557-3.4693c-.4071-.0891-.8316-.0535-1.2189.1026l-.0034.0014c-.6006.2422-1.0631.7338-1.2674 1.3476l-5.279 15.8438c-.2044.6138-.1449 1.286.1608 1.8576 1.3421 2.5084 1.5222 4.4399.1437 5.7696-.3456.3333-.5814.7551-.6819 1.2188l-.0363.2134c-.746 2.6568-.746 5.3136 0 7.9705l.0005-.0005.0004-.0157z" />
    </svg>
  );
}
