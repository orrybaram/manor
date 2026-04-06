import { useCallback, useMemo } from "react";
import { usePreferencesStore } from "../../store/preferences-store";
import Activity from "lucide-react/dist/esm/icons/activity";
import Bot from "lucide-react/dist/esm/icons/bot";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Globe from "lucide-react/dist/esm/icons/globe";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import Rows2 from "lucide-react/dist/esm/icons/rows-2";
import Settings from "lucide-react/dist/esm/icons/settings";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import type { CommandItem, CategoryConfig } from "./types";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { formatCombo } from "../../lib/keybindings";
import { useAppStore, selectActiveWorkspace } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useToastStore } from "../../store/toast-store";
import { DEFAULT_AGENT_COMMAND, getAgentCommand } from "../../agent-defaults";
import { openInEditor } from "../../lib/editor";
import type { ActivePort } from "../../electron.d.ts";
import styles from "./CommandPalette.module.css";

interface UseCommandsParams {
  addTab: () => void;
  addBrowserTab: (url: string) => void;
  closePane: () => void;
  closeTab: (tabId: string) => void;
  splitPane: (direction: "horizontal" | "vertical") => void;
  selectNextTab: () => void;
  selectPrevTab: () => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;
  toggleSidebar: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  onOpenFeedback?: () => void;
  tabs: { id: string }[];
  selectedTabId: string | null;
  setShowGhosts: (show: boolean) => void;
  activePorts: ActivePort[];
  openOrFocusDiff: () => void;
  openDiffInNewPanel: () => void;
  navigateToProcesses: () => void;
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
  toggleSidebar,
  onClose,
  onOpenSettings,
  onOpenFeedback,
  tabs,
  selectedTabId,
  setShowGhosts,
  activePorts,
  openOrFocusDiff,
  openDiffInNewPanel,
  navigateToProcesses,
}: UseCommandsParams): CategoryConfig[] {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const splitPaneAt = useAppStore((s) => s.splitPaneAt);
  const setPaneContentType = useAppStore((s) => s.setPaneContentType);
  const activeWs = useAppStore(selectActiveWorkspace);
  const focusedPaneId = useMemo(() => {
    if (!activeWs) return null;
    const tab = activeWs.tabs.find((s) => s.id === activeWs.selectedTabId);
    return tab?.focusedPaneId ?? null;
  }, [activeWs]);

  const splitWithContent = useCallback(
    (contentType?: "terminal" | "browser" | "diff" | "task", paneCommand?: string) => {
      if (!focusedPaneId) return;
      const el = document.querySelector<HTMLElement>(`[data-pane-id="${focusedPaneId}"]`);
      const direction = el && el.offsetWidth >= el.offsetHeight ? "horizontal" : "vertical";
      splitPaneAt(focusedPaneId, direction, "second", contentType, paneCommand);
    },
    [focusedPaneId, splitPaneAt],
  );

  return useMemo(() => {
    const platform = navigator.platform.toLowerCase().includes("mac")
      ? ("mac" as const)
      : ("other" as const);
    const fmt = (id: string) =>
      bindings[id] ? formatCombo(bindings[id], platform) : undefined;

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
          splitWithContent();
          onClose();
        },
      },
      {
        id: "split-with-browser",
        label: "Split with Browser",
        icon: <Globe size={14} />,
        keywords: ["split", "browser", "pane", "web", "preview"],
        action: () => {
          splitWithContent("browser");
          onClose();
        },
      },
      {
        id: "split-with-diff",
        label: "Split with Diff",
        icon: <GitCompareArrows size={14} />,
        keywords: ["split", "diff", "pane", "git", "changes"],
        action: () => {
          splitWithContent("diff");
          onClose();
        },
      },
      {
        id: "split-with-task",
        label: "Split with Task",
        icon: <Bot size={14} />,
        keywords: ["split", "task", "pane", "agent", "claude"],
        action: () => {
          const awp = useAppStore.getState().activeWorkspacePath;
          const proj = useProjectStore.getState().projects.find((p) =>
            p.workspaces.some((w) => w.path === awp),
          );
          const command = proj?.agentCommand ?? DEFAULT_AGENT_COMMAND;
          splitWithContent("task", command);
          onClose();
        },
      },
      {
        id: "convert-to-terminal",
        label: "Convert to Terminal",
        icon: <SquareTerminal size={14} />,
        keywords: ["convert", "terminal", "pane"],
        action: () => {
          if (focusedPaneId) setPaneContentType(focusedPaneId, "terminal");
          onClose();
        },
      },
      {
        id: "convert-to-browser",
        label: "Convert to Browser",
        icon: <Globe size={14} />,
        keywords: ["convert", "browser", "pane", "web", "preview"],
        action: () => {
          if (focusedPaneId) setPaneContentType(focusedPaneId, "browser");
          onClose();
        },
      },
      {
        id: "convert-to-diff",
        label: "Convert to Diff",
        icon: <GitCompareArrows size={14} />,
        keywords: ["convert", "diff", "pane", "git", "changes"],
        action: () => {
          if (focusedPaneId) setPaneContentType(focusedPaneId, "diff");
          onClose();
        },
      },
      {
        id: "convert-to-task",
        label: "Convert to Task",
        icon: <Bot size={14} />,
        keywords: ["convert", "task", "pane", "agent", "claude"],
        action: () => {
          if (focusedPaneId) {
            const state = useAppStore.getState();
            const command = getAgentCommand(state.activeWorkspacePath);
            const currentType = state.paneContentType[focusedPaneId] ?? "terminal";
            if (currentType === "terminal") {
              window.electronAPI.pty.write(focusedPaneId, command + "\n");
            } else {
              setPaneContentType(focusedPaneId, "terminal");
              useAppStore.setState((s) => ({
                pendingPaneCommands: { ...s.pendingPaneCommands, [focusedPaneId]: command },
              }));
            }
          }
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
          const wsPath = state.activeWorkspacePath;
          if (!wsPath) return;
          const layout = state.workspaceLayouts[wsPath];
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
          const proj = useProjectStore.getState().projects.find((p) =>
            p.workspaces.some((w) => w.path === awp),
          );
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
          const { diffOpensInNewPanel } = usePreferencesStore.getState().preferences;
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
        label: "Toggle Sidebar",
        icon: <PanelLeft size={14} />,
        shortcut: fmt("toggle-sidebar"),
        action: () => {
          toggleSidebar();
          onClose();
        },
      },
      {
        id: "open-in-editor",
        label: "Open in Editor",
        icon: <ExternalLink size={14} />,
        keywords: ["code", ...(editorName ? [editorName] : [])],
        suffix: editorName ? <span className={styles.editorBadge}>{editorName}</span> : undefined,
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
        keywords: ["process", "port", "kill", "daemon", "terminal", "activity", "monitor"],
        action: () => {
          navigateToProcesses();
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
        id: "ghosts",
        label: "Ghosts!?",
        icon: <span>👻</span>,
        action: () => {
          onClose();
          setShowGhosts(true);
          setTimeout(() => setShowGhosts(false), 5000);
        },
      },
    ];

    return [
      { id: "tabs", heading: "Tabs", visible: true, items: tabItems },
      { id: "panes", heading: "Panes", visible: true, items: paneItems },
      { id: "panels", heading: "Panels", visible: true, items: panelItems },
      { id: "git", heading: "Git", visible: true, items: gitItems },
      { id: "ports", heading: "Ports", visible: portItems.length > 0, items: portItems },
      { id: "general", heading: "General", visible: true, items: generalItems },
    ];
  }, [
    addTab,
    addBrowserTab,
    closePane,
    closeTab,
    splitPane,
    splitWithContent,
    selectNextTab,
    selectPrevTab,
    focusNextPane,
    focusPrevPane,
    toggleSidebar,
    onClose,
    onOpenSettings,
    onOpenFeedback,
    tabs,
    selectedTabId,
    setShowGhosts,
    bindings,
    activeWorkspacePath,
    activePorts,
    openOrFocusDiff,
    navigateToProcesses,
  ]);
}
