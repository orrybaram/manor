import { useMemo, type ReactNode } from "react";
import { usePreferencesStore } from "../../store/preferences-store";
import Activity from "lucide-react/dist/esm/icons/activity";
import ArrowRightLeft from "lucide-react/dist/esm/icons/arrow-right-left";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3";
import Bell from "lucide-react/dist/esm/icons/bell";
import Bot from "lucide-react/dist/esm/icons/bot";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Globe from "lucide-react/dist/esm/icons/globe";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import Link from "lucide-react/dist/esm/icons/link";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import Palette from "lucide-react/dist/esm/icons/palette";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import Rows2 from "lucide-react/dist/esm/icons/rows-2";
import Settings from "lucide-react/dist/esm/icons/settings";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import type { CommandItem, CategoryConfig } from "./types";
import type { SettingsPageId } from "../settings/SettingsModal/SettingsModal";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { formatCombo } from "../../lib/keybindings";
import { isWebApp } from "../../lib/platform";
import { availableCommands, getCommand } from "../../lib/commands";
import type { ActivePort } from "../../electron.d.ts";
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

    const tabItems = fromTable([
      { command: "new-tab" },
      { command: "new-browser" },
      { command: "close-tab" },
      { command: "next-tab" },
      { command: "prev-tab" },
    ]);

    const paneItems = fromTable([
      { command: "close-pane" },
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
      {
        command: "move-tab-to-next-panel",
        icon: <ArrowRightLeft size={14} />,
        // ADR-181 D5: the touch idiom for this is dragging a tab into another
        // panel's tab bar, which phone mode disables — this keeps "move" one
        // of the pane/panel actions the palette reaches on its own, matching
        // the tab context menu's "Move Tab to Next Panel" (`TabButton.tsx`).
        keywords: ["panel", "move", "tab"],
      },
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
        id: `open-port-${p.port}`,
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
          addBrowserTab(url);
          onClose();
        },
      };
    });

    const editorName = usePreferencesStore.getState().preferences.defaultEditor || undefined;

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
        { command: "settings", icon: <Settings size={14} /> },
        { command: "toggle-sidebar", icon: <PanelLeft size={14} /> },
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
        keywords: ["settings", "general", "editor", "code editor", "default editor", "diff"],
        action: openSettingsPage("general"),
      },
      {
        id: "settings-appearance",
        label: "Settings: Appearance",
        icon: <Palette size={14} />,
        keywords: ["settings", "appearance", "theme", "dark", "light", "color", "font", "font size", "font family"],
        action: openSettingsPage("app"),
      },
      {
        id: "settings-keybindings",
        label: "Settings: Keybindings",
        icon: <Keyboard size={14} />,
        keywords: ["settings", "keybindings", "shortcuts", "keyboard", "hotkeys", "keys", "bindings"],
        action: openSettingsPage("keybindings"),
      },
      {
        id: "settings-notifications",
        label: "Settings: Notifications",
        icon: <Bell size={14} />,
        keywords: ["settings", "notifications", "notify", "alerts", "sound", "dock badge", "pull requests", "pr", "review", "ci", "comment"],
        action: openSettingsPage("notifications"),
      },
      {
        id: "settings-integrations",
        label: "Settings: Integrations",
        icon: <Link size={14} />,
        keywords: ["settings", "integrations", "github", "linear", "connect", "auth", "token"],
        action: openSettingsPage("integrations"),
      },
      {
        id: "settings-home",
        label: "Settings: Home",
        icon: <Bot size={14} />,
        keywords: ["settings", "home", "harness", "agent", "claude", "codex", "custom", "launch command", "interrupt"],
        action: openSettingsPage("home"),
      },
    ];

    return [
      { id: "tabs", heading: "Tabs", visible: true, items: tabItems },
      { id: "panes", heading: "Panes", visible: true, items: paneItems },
      { id: "panels", heading: "Panels", visible: true, items: panelItems },
      { id: "git", heading: "Git", visible: true, items: gitItems },
      { id: "ports", heading: "Ports", visible: portItems.length > 0, items: portItems },
      { id: "general", heading: "General", visible: true, items: generalItems },
      { id: "settings", heading: "Settings", visible: true, items: settingsItems },
    ];
  }, [
    addBrowserTab,
    onClose,
    onOpenSettings,
    onRunCommand,
    bindings,
    activePorts,
    navigateToProcesses,
    navigateToStats,
  ]);
}
