import { useMemo, type ReactNode } from "react";
import { usePreferencesStore } from "../../store/preferences-store";
import Activity from "lucide-react/dist/esm/icons/activity";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import ArrowRightLeft from "lucide-react/dist/esm/icons/arrow-right-left";
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
import {
  selectActiveLayout,
  selectActivePanelId,
  selectActiveWorkspaceKey,
  selectSelectedTabId,
  useAppStore,
} from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { requestUi } from "../../utils/ui-request";
import { isWebApp } from "../../lib/platform";
import { availableCommands, getCommand } from "../../lib/commands";
import type { ActivePort } from "../../electron.d.ts";
import { isRemoteHost } from "../../lib/hosts";
import { HOME_PATH, isHomePath } from "../../lib/home-path";
import { find } from "../../lib/workspace-directory";
import styles from "./CommandPalette.module.css";

interface UseCommandsParams {
  addBrowserTab: (url: string, opts?: { background?: boolean }) => void;
  onClose: () => void;
  onOpenSettings?: (page?: SettingsPageId) => void;
  /** Run a command-table command through `App`'s one handler map. */
  onRunCommand: (commandId: string, args?: Record<string, unknown>) => void;
  activePorts: ActivePort[];
  navigateToProcesses: () => void;
  navigateToStats: () => void;
}

/** A palette item backed by a command-table entry (ADR-182 D10). */
interface TableItem {
  /** The table command the item runs; its label and shortcut come from it. */
  command: string;
  /**
   * The item's own id and label, where they differ from the command's — a
   * parameterised command (`split-with`), or an id usage ranking already
   * knows (`new-project`).
   */
  id?: string;
  label?: string;
  args?: Record<string, unknown>;
  icon?: ReactNode;
  keywords?: string[];
  suffix?: ReactNode;
  /**
   * Close the palette before running — for a command that moves focus or
   * opens another surface. It runs a frame later, once the closing dialog
   * has let go of the keyboard.
   */
  closeFirst?: true;
}

export function useCommands({
  addBrowserTab,
  onClose,
  onOpenSettings,
  onRunCommand,
  activePorts,
  navigateToProcesses,
  navigateToStats,
}: UseCommandsParams): CategoryConfig[] {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const activeWorkspaceKey = useAppStore(selectActiveWorkspaceKey);
  const activeSurface = useAppStore((s) => s.activeSurface);
  const projects = useProjectStore((s) => s.projects);
  const hasSelectedTab = useAppStore(
    (s) => selectSelectedTabId(s, selectActivePanelId(s)) !== null,
  );
  const activeTabPinned = useAppStore((s) => {
    const layout = selectActiveLayout(s);
    const panelId = selectActivePanelId(s);
    const panel = panelId ? layout?.panels[panelId] : undefined;
    const tabId = selectSelectedTabId(s, panelId);
    return !!panel && !!tabId && (panel.pinnedTabIds ?? []).includes(tabId);
  });
  const panelCount = useAppStore((s) => {
    const layout = selectActiveLayout(s);
    return layout ? Object.keys(layout.panels).length : 0;
  });

  return useMemo(() => {
    const fmt = (id: string) =>
      bindings[id] ? formatCombo(bindings[id]) : undefined;

    // ADR-178: a command whose only implementation is Electron-only (the
    // file dialog, the native menu, a detached window, …) has nothing to do
    // on the web app, so it never appears rather than opening and failing.
    // The table decides which those are; the palette just asks it.
    const available = new Set(
      availableCommands({ web: isWebApp() }).map((def) => def.id),
    );

    /** The palette's view of table commands, minus any this platform lacks. */
    const fromTable = (entries: TableItem[]): CommandItem[] =>
      entries.flatMap((entry): CommandItem[] => {
        const def = getCommand(entry.command);
        if (!def || !available.has(def.id)) return [];
        const run = () => onRunCommand(entry.command, entry.args);
        return [
          {
            id: entry.id ?? def.id,
            label: entry.label ?? def.label,
            icon: entry.icon,
            shortcut: fmt(entry.command),
            keywords: entry.keywords,
            suffix: entry.suffix,
            action: entry.closeFirst
              ? () => {
                  onClose();
                  requestAnimationFrame(run);
                }
              : () => {
                  run();
                  onClose();
                },
          },
        ];
      });

    const onHome = isHomePath(activeWorkspacePath);
    const activeFound =
      onHome || !activeWorkspaceKey ? undefined : find(projects, activeWorkspaceKey);
    const activeProject = activeFound?.project;
    const activeWs = activeFound?.workspace;

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
      ...fromTable([
        {
          command: "history-back",
          icon: <ArrowLeft size={14} />,
          keywords: ["history", "previous", "back"],
          closeFirst: true,
        },
        {
          command: "history-forward",
          icon: <ArrowRight size={14} />,
          keywords: ["history", "next", "forward"],
          closeFirst: true,
        },
      ]),
    ];

    const tabItems: CommandItem[] = fromTable([
      { command: "new-tab" },
      { command: "new-browser" },
      { command: "close-tab" },
      { command: "next-tab" },
      { command: "prev-tab" },
      ...(hasSelectedTab
        ? [
            {
              command: "pin-tab",
              label: activeTabPinned ? "Unpin Tab" : "Pin Tab",
              icon: <Pin size={14} />,
              keywords: ["pin", "unpin", "tab"],
              closeFirst: true as const,
            },
            {
              command: "detach-tab",
              icon: <SquareArrowOutUpRight size={14} />,
              keywords: ["detach", "popout", "window", "tab"],
              closeFirst: true as const,
            },
          ]
        : []),
      ...(panelCount >= 2
        ? [
            {
              command: "move-tab-to-next-panel",
              icon: <ArrowRightLeft size={14} />,
              // ADR-181 D5: the touch idiom for this is dragging a tab into
              // another panel's tab bar, which phone mode disables — the
              // palette is how a phone moves a tab.
              keywords: ["move", "tab", "panel"],
            },
          ]
        : []),
    ]);

    const paneItems = fromTable([
      { command: "close-pane" },
      {
        command: "reopen-pane",
        icon: <Undo2 size={14} />,
        keywords: ["undo", "restore", "reopen", "closed"],
      },
      {
        command: "detach-pane",
        icon: <SquareArrowOutUpRight size={14} />,
        keywords: ["detach", "popout", "window", "pane"],
        closeFirst: true,
      },
      { command: "next-pane" },
      { command: "prev-pane" },
      { command: "split-h", icon: <Columns2 size={14} /> },
      { command: "split-v", icon: <Rows2 size={14} /> },
      {
        command: "split-with",
        id: "split-with-terminal",
        label: "Split with Terminal",
        args: { contentType: "terminal" },
        icon: <SquareTerminal size={14} />,
        keywords: ["split", "terminal", "pane"],
      },
      {
        command: "split-with",
        id: "split-with-browser",
        label: "Split with Browser",
        args: { contentType: "browser" },
        icon: <Globe size={14} />,
        keywords: ["split", "browser", "pane", "web", "preview"],
      },
      {
        command: "split-with",
        id: "split-with-diff",
        label: "Split with Diff",
        args: { contentType: "diff" },
        icon: <GitCompareArrows size={14} />,
        keywords: ["split", "diff", "pane", "git", "changes"],
      },
      {
        command: "split-with",
        id: "split-with-agent",
        label: "Split with Agent",
        args: { contentType: "agent" },
        icon: <Bot size={14} />,
        keywords: ["split", "agent", "pane", "claude"],
      },
      {
        command: "convert-to",
        id: "convert-to-terminal",
        label: "Convert to Terminal",
        args: { contentType: "terminal" },
        icon: <SquareTerminal size={14} />,
        keywords: ["convert", "terminal", "pane"],
      },
      {
        command: "convert-to",
        id: "convert-to-browser",
        label: "Convert to Browser",
        args: { contentType: "browser" },
        icon: <Globe size={14} />,
        keywords: ["convert", "browser", "pane", "web", "preview"],
      },
      {
        command: "convert-to",
        id: "convert-to-diff",
        label: "Convert to Diff",
        args: { contentType: "diff" },
        icon: <GitCompareArrows size={14} />,
        keywords: ["convert", "diff", "pane", "git", "changes"],
      },
      {
        command: "convert-to",
        id: "convert-to-agent",
        label: "Convert to Agent",
        args: { contentType: "agent" },
        icon: <Bot size={14} />,
        keywords: ["convert", "agent", "pane", "claude"],
      },
    ]);

    const panelItems = fromTable([
      {
        command: "split-panel-right",
        icon: <Columns2 size={14} />,
        keywords: ["panel", "split", "right"],
      },
      {
        command: "split-panel-down",
        icon: <Rows2 size={14} />,
        keywords: ["panel", "split", "down"],
      },
      {
        command: "focus-next-panel",
        keywords: ["panel", "next", "focus"],
      },
      {
        command: "focus-prev-panel",
        keywords: ["panel", "previous", "focus"],
      },
      { command: "close-panel", keywords: ["panel", "close"] },
    ]);

    const gitItems = fromTable([
      { command: "copy-branch", keywords: ["git", "branch", "clipboard"] },
      {
        command: "open-diff",
        keywords: ["git", "changes", "diff", "staged"],
      },
    ]);

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
    const workspaceItems: CommandItem[] = fromTable([
      {
        command: "new-workspace",
        label: "New Workspace…",
        icon: <Plus size={14} />,
        keywords: ["create", "worktree", "branch"],
        closeFirst: true,
      },
      {
        command: "next-workspace",
        keywords: ["switch", "workspace"],
        closeFirst: true,
      },
      {
        command: "prev-workspace",
        keywords: ["switch", "workspace"],
        closeFirst: true,
      },
      ...(activeProject && activeWs
        ? [
            {
              command: "rename-workspace",
              icon: <Pencil size={14} />,
              keywords: ["rename", "name", "workspace"],
              closeFirst: true as const,
            },
            {
              command: "copy-workspace-path",
              icon: <Copy size={14} />,
              keywords: ["path", "directory", "folder", "clipboard"],
            },
            {
              command: "reveal-in-finder",
              label: "Reveal in File Manager",
              icon: <FolderOpen size={14} />,
              keywords: ["finder", "explorer", "files", "folder", "reveal", "show"],
            },
            ...(activeProject.worktreeStartScript
              ? [
                  {
                    command: "run-setup-script",
                    icon: <Play size={14} />,
                    keywords: ["setup", "script", "install", "bootstrap"],
                    closeFirst: true as const,
                  },
                ]
              : []),
            {
              command: "hide-workspace",
              icon: <EyeOff size={14} />,
              keywords: ["hide", "archive", "workspace"],
              closeFirst: true as const,
            },
            ...(activeWs.isMain
              ? []
              : [
                  {
                    command: "merge-worktree",
                    label: "Merge Worktree…",
                    icon: <GitMerge size={14} />,
                    keywords: ["merge", "worktree", "git", "branch"],
                    closeFirst: true as const,
                  },
                  {
                    command: "delete-worktree",
                    label: "Delete Worktree…",
                    icon: <Trash2 size={14} />,
                    keywords: ["delete", "remove", "worktree", "branch"],
                    closeFirst: true as const,
                  },
                ]),
            {
              command: "project-settings",
              label: "Project Settings…",
              icon: <Settings size={14} />,
              keywords: ["project", "settings", "config", activeProject.name],
              closeFirst: true as const,
            },
          ]
        : []),
    ]);

    const generalItems: CommandItem[] = [
      ...fromTable([
        {
          command: "add-project",
          id: "new-project",
          label: "New Project",
          icon: <FolderPlus size={14} />,
          keywords: ["add", "create", "project", "folder", "directory", "repo", "open"],
          closeFirst: true,
        },
      ]),
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
      ...fromTable([
        { command: "settings", icon: <Settings size={14} /> },
        { command: "toggle-sidebar", icon: <PanelLeft size={14} /> },
        { command: "hide-sidebar", icon: <PanelLeft size={14} /> },
        {
          command: "focus-sidebar",
          icon: <PanelLeft size={14} />,
          keywords: ["keyboard", "navigate"],
          closeFirst: true,
        },
        {
          command: "focus-tabbar",
          icon: <Keyboard size={14} />,
          keywords: ["keyboard", "navigate", "tabs"],
          closeFirst: true,
        },
        {
          command: "focus-next-region",
          icon: <Keyboard size={14} />,
          keywords: ["keyboard", "navigate", "region", "cycle"],
          closeFirst: true,
        },
        {
          command: "focus-prev-region",
          icon: <Keyboard size={14} />,
          keywords: ["keyboard", "navigate", "region", "cycle"],
          closeFirst: true,
        },
        {
          command: "open-notifications",
          icon: <Bell size={14} />,
          keywords: ["notifications", "bell", "alerts"],
          closeFirst: true,
        },
        {
          command: "open-in-editor",
          icon: <ExternalLink size={14} />,
          keywords: ["code", ...(editorName ? [editorName] : [])],
          suffix: editorName ? <span className={styles.editorBadge}>{editorName}</span> : undefined,
        },
      ]),
      {
        id: "processes",
        label: "Processes",
        icon: <Activity size={14} />,
        suffix: <ChevronRight size={14} />,
        keywords: ["process", "port", "kill", "daemon", "terminal", "activity", "monitor"],
        action: () => {
          navigateToProcesses();
        },
      },
      {
        id: "show-stats",
        label: "Show Stats",
        icon: <BarChart3 size={14} />,
        suffix: <ChevronRight size={14} />,
        keywords: ["stats", "statistics", "streak", "badges", "usage", "counters"],
        action: () => {
          navigateToStats();
        },
      },
      ...fromTable([
        {
          command: "submit-feedback",
          icon: <MessageSquare size={14} />,
          keywords: ["bug", "feature", "request", "report"],
        },
        {
          command: "help-docs",
          icon: <BookOpen size={14} />,
          keywords: ["help", "docs", "documentation", "readme"],
          closeFirst: true,
        },
        {
          command: "help-release-notes",
          icon: <BookOpen size={14} />,
          keywords: ["changelog", "whats new", "version", "help"],
          closeFirst: true,
        },
        {
          command: "help-report-issue",
          icon: <ExternalLink size={14} />,
          keywords: ["bug", "report", "issue", "github", "help"],
          closeFirst: true,
        },
        { command: "ghosts", icon: <span>👻</span>, closeFirst: true },
      ]),
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
    // The Tasks view covers the workspace, which
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
        visible: workspaceItems.length > 0,
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
    addBrowserTab,
    onClose,
    onOpenSettings,
    onRunCommand,
    bindings,
    activeWorkspacePath,
    activeWorkspaceKey,
    activePorts,
    navigateToProcesses,
    navigateToStats,
    activeSurface,
    projects,
    hasSelectedTab,
    activeTabPinned,
    panelCount,
  ]);
}
