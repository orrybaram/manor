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
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}
