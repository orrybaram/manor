import { useMemo } from "react";
import { usePreferencesStore } from "../../store/preferences-store";
import Activity from "lucide-react/dist/esm/icons/activity";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3";
import Bell from "lucide-react/dist/esm/icons/bell";
import BookOpen from "lucide-react/dist/esm/icons/book-open";
import Bot from "lucide-react/dist/esm/icons/bot";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import Copy from "lucide-react/dist/esm/icons/copy";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import EyeOff from "lucide-react/dist/esm/icons/eye-off";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Folders from "lucide-react/dist/esm/icons/folders";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Globe from "lucide-react/dist/esm/icons/globe";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import LayoutDashboard from "lucide-react/dist/esm/icons/layout-dashboard";
import Link from "lucide-react/dist/esm/icons/link";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import Palette from "lucide-react/dist/esm/icons/palette";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Pin from "lucide-react/dist/esm/icons/pin";
import Play from "lucide-react/dist/esm/icons/play";
import Plus from "lucide-react/dist/esm/icons/plus";
import RadioTower from "lucide-react/dist/esm/icons/radio-tower";
import Rows2 from "lucide-react/dist/esm/icons/rows-2";
import Settings from "lucide-react/dist/esm/icons/settings";
import SquareArrowOutUpRight from "lucide-react/dist/esm/icons/square-arrow-out-up-right";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Undo2 from "lucide-react/dist/esm/icons/undo-2";
import type { CommandItem, CategoryConfig } from "./types";
import type { SettingsPageId } from "../settings/SettingsModal/SettingsModal";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { formatCombo } from "../../lib/keybindings";
import { selectActiveLayout, useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useToastStore } from "../../store/toast-store";
import { getAgentCommand } from "../../agent-defaults";
import { openInEditor } from "../../lib/editor";
import {
  convertFocusedPaneTo,
  splitFocusedPaneWith,
} from "../../lib/pane-actions";
import { requestUi } from "../../utils/ui-request";
import { focusRegionWhenReady } from "../../lib/focus-regions";
import type { ActivePort } from "../../electron.d.ts";
import { isRemoteHost } from "../../lib/hosts";
import { HOME_PATH, isHomePath } from "../../lib/home-path";
import { EXTERNAL_LINKS } from "../../lib/menu-commands";
import {
  navigateBack,
  navigateForward,
} from "../../hooks/useNavigationHistory";
import styles from "./CommandPalette.module.css";

interface UseCommandsParams {
  addTab: () => void;
  addBrowserTab: (url: string, opts?: { background?: boolean }) => void;
  closePane: () => void;
  closeTab: (tabId: string) => void;
  splitPane: (direction: "horizontal" | "vertical") => void;
  selectNextTab: () => void;
  selectPrevTab: () => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;
  onClose: () => void;
  onOpenSettings?: (page?: SettingsPageId) => void;
  onOpenFeedback?: () => void;
  tabs: { id: string }[];
  selectedTabId: string | null;
  activePorts: ActivePort[];
  openOrFocusDiff: () => void;
  openDiffInNewPanel: () => void;
  navigateToProcesses: () => void;
  navigateToStats: () => void;
  /**
   * Run a command from the primary window's command map (`createMenuHandlers`),
   * so the palette shares the keyboard's and the native menu's actions.
   */
  runCommand?: (commandId: string) => void;
}

export function useCommands({
  addTab,
  addBrowserTab,
  closePane,
  closeTab,
  splitPane,
  selectNextTab,
  selectPrevTab,
  focusNextPane,
  focusPrevPane,
  onClose,
  onOpenSettings,
  onOpenFeedback,
  tabs,
  selectedTabId,
  activePorts,
  openOrFocusDiff,
  openDiffInNewPanel,
  navigateToProcesses,
  navigateToStats,
  runCommand,
}: UseCommandsParams): CategoryConfig[] {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeSurface = useAppStore((s) => s.activeSurface);
  const projects = useProjectStore((s) => s.projects);
  const activeTabPinned = useAppStore((s) => {
    const layout = selectActiveLayout(s);
    const panel = layout?.panels[layout.activePanelId];
    return !!panel && (panel.pinnedTabIds ?? []).includes(panel.selectedTabId);
  });
  const panelCount = useAppStore((s) => {
    const layout = selectActiveLayout(s);
    return layout ? Object.keys(layout.panels).length : 0;
  });

  return useMemo(() => {
    const fmt = (id: string) =>
      bindings[id] ? formatCombo(bindings[id]) : undefined;

    /** Close the palette, then run a command from the shared command map. */
    const run = (commandId: string) => () => {
      onClose();
      runCommand?.(commandId);
    };

    const onHome = isHomePath(activeWorkspacePath);
    const activeProject = onHome
      ? undefined
      : projects.find((p) =>
          p.workspaces.some((w) => w.path === activeWorkspacePath),
        );
    const activeWs = activeProject?.workspaces.find(
      (w) => w.path === activeWorkspacePath,
    );

    // The app's destinations, mirroring the sidebar's nav (ADR-194/197/198).
    const goToItems: CommandItem[] = [
      {
        id: "go-dashboard",
        label: "Dashboard",
        icon: <LayoutDashboard size={14} />,
        keywords: ["home", "overview", "go", "open", "show"],
        isActive: onHome && activeSurface === "workspace",
        action: () => {
          onClose();
          useAppStore.getState().setActiveWorkspace(HOME_PATH);
        },
      },
      {
        id: "go-tasks",
        label: "Tasks",
        icon: <ListTodo size={14} />,
        keywords: [
          "issues",
          "tickets",
          "todo",
          "linear",
          "github",
          "go",
          "open",
          "show",
        ],
        isActive: activeSurface === "tasks",
        action: () => {
          onClose();
          useAppStore.getState().showTasksView();
        },
      },
      {
        id: "go-projects",
        label: "Projects",
        icon: <Folders size={14} />,
        keywords: ["overview", "repos", "repositories", "go", "open", "show"],
        isActive: activeSurface === "projects",
        action: () => {
          onClose();
          useAppStore.getState().showProjectsOverview();
        },
      },
      {
        id: "history-back",
        label: "Navigate Back",
        icon: <ArrowLeft size={14} />,
        shortcut: fmt("history-back"),
        keywords: ["history", "previous", "back"],
        action: () => {
          onClose();
          navigateBack();
        },
      },
      {
        id: "history-forward",
        label: "Navigate Forward",
        icon: <ArrowRight size={14} />,
        shortcut: fmt("history-forward"),
        keywords: ["history", "next", "forward"],
        action: () => {
          onClose();
          navigateForward();
        },
      },
    ];

    const tabItems: CommandItem[] = [
      {
        id: "new-tab",
        label: "New Tab",
        shortcut: fmt("new-tab"),
        action: () => {
          addTab();
          onClose();
        },
      },
      {
        id: "new-browser",
        label: "New Browser Window",
        shortcut: fmt("new-browser"),
        action: () => {
          addBrowserTab("about:blank");
          onClose();
        },
      },
      {
        id: "close-tab",
        label: "Close Tab",
        shortcut: fmt("close-tab"),
        action: () => {
          const tab = tabs.find((s) => s.id === selectedTabId);
          if (tab) closeTab(tab.id);
          onClose();
        },
      },
      {
        id: "next-tab",
        label: "Next Tab",
        shortcut: fmt("next-tab"),
        action: () => {
          selectNextTab();
          onClose();
        },
      },
      {
        id: "prev-tab",
        label: "Previous Tab",
        shortcut: fmt("prev-tab"),
        action: () => {
          selectPrevTab();
          onClose();
        },
      },
      ...(selectedTabId
        ? [
            {
              id: "pin-tab",
              label: activeTabPinned ? "Unpin Tab" : "Pin Tab",
              icon: <Pin size={14} />,
              keywords: ["pin", "unpin", "tab"],
              action: run("pin-tab"),
            },
            {
              id: "detach-tab",
              label: "Move Tab to New Window",
              icon: <SquareArrowOutUpRight size={14} />,
              keywords: ["detach", "popout", "window", "tab"],
              action: run("detach-tab"),
            },
          ]
        : []),
      ...(panelCount >= 2
        ? [
            {
              id: "move-tab-to-next-panel",
              label: "Move Tab to Next Panel",
              shortcut: fmt("move-tab-to-next-panel"),
              keywords: ["move", "tab", "panel"],
              action: run("move-tab-to-next-panel"),
            },
          ]
        : []),
    ];

    const paneItems: CommandItem[] = [
      {
        id: "close-pane",
        label: "Close Pane",
        shortcut: fmt("close-pane"),
        action: () => {
          closePane();
          onClose();
        },
      },
      {
        id: "reopen-pane",
        label: "Reopen Closed Pane",
        icon: <Undo2 size={14} />,
        shortcut: fmt("reopen-pane"),
        keywords: ["undo", "restore", "reopen", "closed"],
        action: () => {
          useAppStore.getState().reopenClosedPane();
          onClose();
        },
      },
      {
        id: "detach-pane",
        label: "Move Pane to New Window",
        icon: <SquareArrowOutUpRight size={14} />,
        keywords: ["detach", "popout", "window", "pane"],
        action: run("detach-pane"),
      },
      {
        id: "next-pane",
        label: "Next Pane",
        shortcut: fmt("next-pane"),
        action: () => {
          focusNextPane();
          onClose();
        },
      },
      {
        id: "prev-pane",
        label: "Previous Pane",
        shortcut: fmt("prev-pane"),
        action: () => {
          focusPrevPane();
          onClose();
        },
      },
      {
        id: "split-h",
        label: "Split Horizontal",
        icon: <Columns2 size={14} />,
        shortcut: fmt("split-h"),
        action: () => {
          splitPane("horizontal");
          onClose();
        },
      },
      {
        id: "split-v",
        label: "Split Vertical",
        icon: <Rows2 size={14} />,
        shortcut: fmt("split-v"),
        action: () => {
          splitPane("vertical");
          onClose();
        },
      },
      {
        id: "split-with-terminal",
        label: "Split with Terminal",
        icon: <SquareTerminal size={14} />,
        keywords: ["split", "terminal", "pane"],
        action: () => {
          splitFocusedPaneWith();
          onClose();
        },
      },
      {
        id: "split-with-browser",
        label: "Split with Browser",
        icon: <Globe size={14} />,
        keywords: ["split", "browser", "pane", "web", "preview"],
        action: () => {
          splitFocusedPaneWith("browser");
          onClose();
        },
      },
      {
        id: "split-with-diff",
        label: "Split with Diff",
        icon: <GitCompareArrows size={14} />,
        keywords: ["split", "diff", "pane", "git", "changes"],
        action: () => {
          splitFocusedPaneWith("diff");
          onClose();
        },
      },
      {
        id: "split-with-agent",
        label: "Split with Agent",
        icon: <Bot size={14} />,
        keywords: ["split", "agent", "pane", "claude"],
        action: () => {
          const awp = useAppStore.getState().activeWorkspacePath;
          splitFocusedPaneWith("agent", getAgentCommand(awp));
          onClose();
        },
      },
      {
        id: "convert-to-terminal",
        label: "Convert to Terminal",
        icon: <SquareTerminal size={14} />,
        keywords: ["convert", "terminal", "pane"],
        action: () => {
          convertFocusedPaneTo("terminal");
          onClose();
        },
      },
      {
        id: "convert-to-browser",
        label: "Convert to Browser",
        icon: <Globe size={14} />,
        keywords: ["convert", "browser", "pane", "web", "preview"],
        action: () => {
          convertFocusedPaneTo("browser");
          onClose();
        },
      },
      {
        id: "convert-to-diff",
        label: "Convert to Diff",
        icon: <GitCompareArrows size={14} />,
        keywords: ["convert", "diff", "pane", "git", "changes"],
        action: () => {
          convertFocusedPaneTo("diff");
          onClose();
        },
      },
      {
        id: "convert-to-agent",
        label: "Convert to Agent",
        icon: <Bot size={14} />,
        keywords: ["convert", "agent", "pane", "claude"],
        action: () => {
          convertFocusedPaneTo("agent");
          onClose();
        },
      },
    ];

    const panelItems: CommandItem[] = [
      {
        id: "split-panel-right",
        label: "Split Panel Right",
        icon: <Columns2 size={14} />,
        shortcut: fmt("split-panel-right"),
        keywords: ["panel", "split", "right"],
        action: () => {
          useAppStore.getState().splitPanel("horizontal");
          onClose();
        },
      },
      {
        id: "split-panel-down",
        label: "Split Panel Down",
        icon: <Rows2 size={14} />,
        shortcut: fmt("split-panel-down"),
        keywords: ["panel", "split", "down"],
        action: () => {
          useAppStore.getState().splitPanel("vertical");
          onClose();
        },
      },
      {
        id: "focus-next-panel",
        label: "Focus Next Panel",
        shortcut: fmt("focus-next-panel"),
        keywords: ["panel", "next", "focus"],
        action: () => {
          useAppStore.getState().focusNextPanel();
          onClose();
        },
      },
      {
        id: "focus-prev-panel",
        label: "Focus Previous Panel",
        shortcut: fmt("focus-prev-panel"),
        keywords: ["panel", "previous", "focus"],
        action: () => {
          useAppStore.getState().focusPrevPanel();
          onClose();
        },
      },
      {
        id: "close-panel",
        label: "Close Panel",
        keywords: ["panel", "close"],
        action: () => {
          const state = useAppStore.getState();
          const layout = selectActiveLayout(state);
          if (!layout) return;
          state.closePanel(layout.activePanelId);
          onClose();
        },
      },
    ];

    const gitItems: CommandItem[] = [
      {
        id: "copy-branch",
        label: "Copy Branch Name",
        shortcut: fmt("copy-branch"),
        keywords: ["git", "branch", "clipboard"],
        action: () => {
          const awp = useAppStore.getState().activeWorkspacePath;
          const proj = useProjectStore
            .getState()
            .projects.find((p) => p.workspaces.some((w) => w.path === awp));
          const ws = proj?.workspaces.find((w) => w.path === awp);
          const branch = ws?.branch;
          if (branch) {
            navigator.clipboard.writeText(branch);
            useToastStore.getState().addToast({
              id: `copy-branch-${Date.now()}`,
              message: `Copied "${branch}"`,
              status: "success",
            });
          }
          onClose();
        },
      },
      {
        id: "open-diff",
        label: "Open Diff",
        shortcut: fmt("open-diff"),
        keywords: ["git", "changes", "diff", "staged"],
        action: () => {
          const { diffOpensInNewPanel } =
            usePreferencesStore.getState().preferences;
          if (diffOpensInNewPanel) {
            openDiffInNewPanel();
          } else {
            openOrFocusDiff();
          }
          onClose();
        },
      },
    ];

    const portItems: CommandItem[] = activePorts.map((p): CommandItem => {
      const url = p.hostname
        ? `http://${p.hostname}`
        : `http://localhost:${p.port}`;
      const displayName = p.hostname
        ? p.hostname.replace(/\.localhost(:\d+)?$/, "")
        : p.processName;
      return {
        id: isRemoteHost(p.hostId)
          ? `open-port-${p.hostId}-${p.port}`
          : `open-port-${p.port}`,
        label: `Open Browser ${displayName}`,
        icon: <Globe size={14} />,
        keywords: [
          "port",
          "browser",
          "localhost",
          "server",
          "web",
          "preview",
          "dev",
          "open",
          "launch",
          String(p.port),
          p.processName,
        ],
        action: () => {
          // A remote host's port opens through its forward (ADR-178 §5).
          if (isRemoteHost(p.hostId)) {
            window.electronAPI.ports
              .resolveUrl(url, p.hostId)
              .then(addBrowserTab, () => addBrowserTab(url));
          } else {
            addBrowserTab(url);
          }
          onClose();
        },
      };
    });

    const editorName =
      usePreferencesStore.getState().preferences.defaultEditor || undefined;

    // The active workspace's own actions, as in the native Workspace menu.
    const workspaceItems: CommandItem[] = [
      {
        id: "new-workspace",
        label: "New Workspace…",
        icon: <Plus size={14} />,
        shortcut: fmt("new-workspace"),
        keywords: ["create", "worktree", "branch"],
        action: run("new-workspace"),
      },
      {
        id: "next-workspace",
        label: "Next Workspace",
        shortcut: fmt("next-workspace"),
        keywords: ["switch", "workspace"],
        action: run("next-workspace"),
      },
      {
        id: "prev-workspace",
        label: "Previous Workspace",
        shortcut: fmt("prev-workspace"),
        keywords: ["switch", "workspace"],
        action: run("prev-workspace"),
      },
    ];
    if (activeProject && activeWs) {
      workspaceItems.push(
        {
          id: "rename-workspace",
          label: "Rename Workspace",
          icon: <Pencil size={14} />,
          keywords: ["rename", "name", "workspace"],
          action: run("rename-workspace"),
        },
        {
          id: "copy-workspace-path",
          label: "Copy Workspace Path",
          icon: <Copy size={14} />,
          keywords: ["path", "directory", "folder", "clipboard"],
          action: run("copy-workspace-path"),
        },
        {
          id: "reveal-in-finder",
          label: "Reveal in File Manager",
          icon: <FolderOpen size={14} />,
          keywords: ["finder", "explorer", "files", "folder", "reveal", "show"],
          action: run("reveal-in-finder"),
        },
        ...(activeProject.worktreeStartScript
          ? [
              {
                id: "run-setup-script",
                label: "Run Setup Script",
                icon: <Play size={14} />,
                keywords: ["setup", "script", "install", "bootstrap"],
                action: run("run-setup-script"),
              },
            ]
          : []),
        {
          id: "hide-workspace",
          label: "Hide Workspace",
          icon: <EyeOff size={14} />,
          keywords: ["hide", "archive", "workspace"],
          action: run("hide-workspace"),
        },
        ...(activeWs.isMain
          ? []
          : [
              {
                id: "merge-worktree",
                label: "Merge Worktree…",
                icon: <GitMerge size={14} />,
                keywords: ["merge", "worktree", "git", "branch"],
                action: run("merge-worktree"),
              },
              {
                id: "delete-worktree",
                label: "Delete Worktree…",
                icon: <Trash2 size={14} />,
                keywords: ["delete", "remove", "worktree", "branch"],
                action: run("delete-worktree"),
              },
            ]),
        {
          id: "project-settings",
          label: "Project Settings…",
          icon: <Settings size={14} />,
          keywords: ["project", "settings", "config", activeProject.name],
          action: run("project-settings"),
        },
      );
    }

    const generalItems: CommandItem[] = [
      {
        id: "new-project",
        label: "New Project",
        icon: <FolderPlus size={14} />,
        keywords: [
          "add",
          "create",
          "project",
          "folder",
          "directory",
          "repo",
          "open",
        ],
        action: () => {
          onClose();
          void useProjectStore.getState().addProjectFromDirectory();
        },
      },
      {
        id: "clone-repository",
        label: "Clone Repository…",
        icon: <GitBranch size={14} />,
        keywords: ["clone", "git", "github", "repo", "repository", "project", "new", "add"],
        action: () => {
          onClose();
          // The Add Project dialog is `App` state; ask it over the UI bus.
          requestUi({ type: "clone-repository" });
        },
      },
      {
        id: "settings",
        label: "Settings",
        icon: <Settings size={14} />,
        shortcut: fmt("settings"),
        action: () => {
          onOpenSettings?.();
          onClose();
        },
      },
      {
        id: "toggle-sidebar",
        label: "Collapse Sidebar",
        icon: <PanelLeft size={14} />,
        shortcut: fmt("toggle-sidebar"),
        action: () => {
          useProjectStore.getState().toggleSidebarRail();
          onClose();
        },
      },
      {
        id: "hide-sidebar",
        label: "Hide Sidebar",
        icon: <PanelLeft size={14} />,
        shortcut: fmt("hide-sidebar"),
        action: () => {
          useProjectStore.getState().toggleSidebarHidden();
          onClose();
        },
      },
      {
        id: "focus-sidebar",
        label: "Focus Sidebar",
        icon: <PanelLeft size={14} />,
        shortcut: fmt("focus-sidebar"),
        keywords: ["keyboard", "navigate"],
        action: () => {
          onClose();
          const { sidebarMode, lastVisibleSidebarMode, setSidebarMode } =
            useProjectStore.getState();
          if (sidebarMode === "hidden") setSidebarMode(lastVisibleSidebarMode);
          focusRegionWhenReady("sidebar");
        },
      },
      {
        id: "focus-tabbar",
        label: "Focus Tab Bar",
        icon: <Keyboard size={14} />,
        shortcut: fmt("focus-tabbar"),
        keywords: ["keyboard", "navigate", "tabs"],
        action: () => {
          onClose();
          focusRegionWhenReady("tabbar");
        },
      },
      {
        id: "focus-next-region",
        label: "Focus Next Region",
        icon: <Keyboard size={14} />,
        shortcut: fmt("focus-next-region"),
        keywords: ["keyboard", "navigate", "region", "cycle"],
        action: run("focus-next-region"),
      },
      {
        id: "focus-prev-region",
        label: "Focus Previous Region",
        icon: <Keyboard size={14} />,
        shortcut: fmt("focus-prev-region"),
        keywords: ["keyboard", "navigate", "region", "cycle"],
        action: run("focus-prev-region"),
      },
      {
        id: "open-notifications",
        label: "Open Notifications",
        icon: <Bell size={14} />,
        shortcut: fmt("open-notifications"),
        keywords: ["notifications", "bell", "alerts"],
        action: () => {
          onClose();
          requestUi({ type: "open-notifications" });
        },
      },
      {
        id: "open-in-editor",
        label: "Open in Editor",
        icon: <ExternalLink size={14} />,
        keywords: ["code", ...(editorName ? [editorName] : [])],
        suffix: editorName ? (
          <span className={styles.editorBadge}>{editorName}</span>
        ) : undefined,
        action: () => {
          if (activeWorkspacePath) {
            openInEditor(activeWorkspacePath);
          }
          onClose();
        },
      },
      {
        id: "processes",
        label: "Processes",
        icon: <Activity size={14} />,
        suffix: <ChevronRight size={14} />,
        keywords: [
          "process",
          "port",
          "kill",
          "daemon",
          "terminal",
          "activity",
          "monitor",
        ],
        action: () => {
          navigateToProcesses();
        },
      },
      {
        id: "show-stats",
        label: "Show Stats",
        icon: <BarChart3 size={14} />,
        suffix: <ChevronRight size={14} />,
        keywords: [
          "stats",
          "statistics",
          "streak",
          "badges",
          "usage",
          "counters",
        ],
        action: () => {
          navigateToStats();
        },
      },
      {
        id: "submit-feedback",
        label: "Submit Feedback",
        icon: <MessageSquare size={14} />,
        keywords: ["bug", "feature", "request", "report"],
        action: () => {
          onOpenFeedback?.();
          onClose();
        },
      },
      {
        id: "help-docs",
        label: "Manor Help",
        icon: <BookOpen size={14} />,
        keywords: ["help", "docs", "documentation", "readme"],
        action: () => {
          onClose();
          void window.electronAPI.shell.openExternal(EXTERNAL_LINKS.docs);
        },
      },
      {
        id: "help-release-notes",
        label: "Release Notes",
        icon: <BookOpen size={14} />,
        keywords: ["changelog", "whats new", "version", "help"],
        action: () => {
          onClose();
          void window.electronAPI.shell.openExternal(
            EXTERNAL_LINKS.releaseNotes,
          );
        },
      },
      {
        id: "help-report-issue",
        label: "Report an Issue on GitHub",
        icon: <ExternalLink size={14} />,
        keywords: ["bug", "report", "issue", "github", "help"],
        action: () => {
          onClose();
          void window.electronAPI.shell.openExternal(EXTERNAL_LINKS.newIssue);
        },
      },
      {
        id: "ghosts",
        label: "Ghosts!?",
        icon: <span>👻</span>,
        action: () => {
          onClose();
          requestUi({ type: "ghosts" });
        },
      },
    ];

    const openSettingsPage = (page: SettingsPageId) => () => {
      onOpenSettings?.(page);
      onClose();
    };

    const settingsItems: CommandItem[] = [
      {
        id: "settings-general",
        label: "Settings: General",
        icon: <Settings size={14} />,
        keywords: [
          "settings",
          "general",
          "editor",
          "code editor",
          "default editor",
          "diff",
        ],
        action: openSettingsPage("general"),
      },
      {
        id: "settings-appearance",
        label: "Settings: Appearance",
        icon: <Palette size={14} />,
        keywords: [
          "settings",
          "appearance",
          "theme",
          "dark",
          "light",
          "color",
          "font",
          "font size",
          "font family",
        ],
        action: openSettingsPage("app"),
      },
      {
        id: "settings-keybindings",
        label: "Settings: Keybindings",
        icon: <Keyboard size={14} />,
        keywords: [
          "settings",
          "keybindings",
          "shortcuts",
          "keyboard",
          "hotkeys",
          "keys",
          "bindings",
        ],
        action: openSettingsPage("keybindings"),
      },
      {
        id: "settings-notifications",
        label: "Settings: Notifications",
        icon: <Bell size={14} />,
        keywords: [
          "settings",
          "notifications",
          "notify",
          "alerts",
          "sound",
          "dock badge",
          "pull requests",
          "pr",
          "review",
          "ci",
          "comment",
        ],
        action: openSettingsPage("notifications"),
      },
      {
        id: "settings-integrations",
        label: "Settings: Integrations",
        icon: <Link size={14} />,
        keywords: [
          "settings",
          "integrations",
          "github",
          "linear",
          "connect",
          "auth",
          "token",
        ],
        action: openSettingsPage("integrations"),
      },
      {
        id: "settings-remote",
        label: "Settings: Remote Control",
        icon: <RadioTower size={14} />,
        keywords: [
          "settings",
          "remote",
          "remote control",
          "hosts",
          "ssh",
          "mobile",
        ],
        action: openSettingsPage("remote"),
      },
    ];

    // The Dashboard has no tabs or panes (ADR-197): hide anything that would
    // create or rearrange them.
    const HOME_HIDDEN =
      /^(new-tab|new-browser|split-|convert-to-|open-diff$|reopen-pane$|detach-|pin-tab$|move-tab-)/;
    // The Projects overview and the Tasks view cover the workspace, which
    // stays mounted underneath: don't close or move what the user can't see
    // (the same rule as `unlessOverviewShown` for the shortcuts).
    const OVERVIEW_HIDDEN =
      /^(close-(tab|pane|panel)$|detach-|pin-tab$|move-tab-)/;
    const onOverview = activeSurface !== "workspace";
    const unlessHomeItems = (items: CommandItem[]) =>
      items.filter(
        (i) =>
          !(onHome && HOME_HIDDEN.test(i.id)) &&
          !(onOverview && OVERVIEW_HIDDEN.test(i.id)),
      );
    const visiblePortItems = onHome ? [] : portItems;

    return [
      { id: "go-to", heading: "Go to", visible: true, items: goToItems },
      { id: "tabs", heading: "Tabs", visible: true, items: unlessHomeItems(tabItems) },
      { id: "panes", heading: "Panes", visible: true, items: unlessHomeItems(paneItems) },
      { id: "panels", heading: "Panels", visible: true, items: unlessHomeItems(panelItems) },
      { id: "git", heading: "Git", visible: true, items: unlessHomeItems(gitItems) },
      {
        id: "workspace",
        heading: "Workspace",
        visible: !!runCommand,
        items: workspaceItems,
      },
      {
        id: "ports",
        heading: "Ports",
        visible: visiblePortItems.length > 0,
        items: visiblePortItems,
      },
      { id: "general", heading: "General", visible: true, items: generalItems },
      {
        id: "settings",
        heading: "Settings",
        visible: true,
        items: settingsItems,
      },
    ];
  }, [
    addTab,
    addBrowserTab,
    closePane,
    closeTab,
    splitPane,
    selectNextTab,
    selectPrevTab,
    focusNextPane,
    focusPrevPane,
    onClose,
    onOpenSettings,
    onOpenFeedback,
    tabs,
    selectedTabId,
    bindings,
    activeWorkspacePath,
    activePorts,
    openOrFocusDiff,
    openDiffInNewPanel,
    navigateToProcesses,
    navigateToStats,
    runCommand,
    activeSurface,
    projects,
    activeTabPinned,
    panelCount,
  ]);
}
