import { useCallback, useMemo } from "react";
import Bot from "lucide-react/dist/esm/icons/bot";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Globe from "lucide-react/dist/esm/icons/globe";
import Rows2 from "lucide-react/dist/esm/icons/rows-2";
import SquareTerminal from "lucide-react/dist/esm/icons/square-terminal";
import type { CommandItem } from "./types";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { formatCombo } from "../../lib/keybindings";
import { useAppStore, selectActiveWorkspace } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useToastStore } from "../../store/toast-store";
import { DEFAULT_AGENT_COMMAND } from "../../agent-defaults";
import type { ActivePort } from "../../electron.d.ts";

interface UseCommandsParams {
  addSession: () => void;
  addBrowserSession: (url: string) => void;
  closePane: () => void;
  closeSession: (sessionId: string) => void;
  splitPane: (direction: "horizontal" | "vertical") => void;
  selectNextSession: () => void;
  selectPrevSession: () => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;
  toggleSidebar: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  onOpenFeedback?: () => void;
  sessions: { id: string }[];
  selectedSessionId: string | null;
  setShowGhosts: (show: boolean) => void;
  activePorts: ActivePort[];
  openOrFocusDiff: () => void;
}

export function useCommands({
  addSession,
  addBrowserSession,
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
  onOpenFeedback,
  sessions,
  selectedSessionId,
  setShowGhosts,
  activePorts,
  openOrFocusDiff,
}: UseCommandsParams): CommandItem[] {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const splitPaneAt = useAppStore((s) => s.splitPaneAt);
  const activeWs = useAppStore(selectActiveWorkspace);
  const focusedPaneId = useMemo(() => {
    if (!activeWs) return null;
    const session = activeWs.sessions.find((s) => s.id === activeWs.selectedSessionId);
    return session?.focusedPaneId ?? null;
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
    return [
      {
        id: "new-session",
        label: "New Session",
        shortcut: fmt("new-session"),
        action: () => {
          addSession();
          onClose();
        },
      },
      {
        id: "new-browser",
        label: "New Browser Window",
        action: () => {
          addBrowserSession("about:blank");
          onClose();
        },
      },
      {
        id: "open-diff",
        label: "Open Diff",
        keywords: ["git", "changes", "diff", "staged"],
        action: () => {
          openOrFocusDiff();
          onClose();
        },
      },
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
        id: "close-session",
        label: "Close Session",
        shortcut: fmt("close-session"),
        action: () => {
          const session = sessions.find((s) => s.id === selectedSessionId);
          if (session) closeSession(session.id);
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
        id: "next-session",
        label: "Next Session",
        shortcut: fmt("next-session"),
        action: () => {
          selectNextSession();
          onClose();
        },
      },
      {
        id: "prev-session",
        label: "Previous Session",
        shortcut: fmt("prev-session"),
        action: () => {
          selectPrevSession();
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
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        shortcut: fmt("toggle-sidebar"),
        action: () => {
          toggleSidebar();
          onClose();
        },
      },
      {
        id: "settings",
        label: "Settings",
        shortcut: fmt("settings"),
        action: () => {
          onOpenSettings?.();
          onClose();
        },
      },
      {
        id: "submit-feedback",
        label: "Submit Feedback",
        keywords: ["bug", "feature", "request", "report"],
        action: () => {
          onOpenFeedback?.();
          onClose();
        },
      },
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
        id: "open-in-editor",
        label: "Open in Editor",
        keywords: ["code"],
        action: () => {
          if (activeWorkspacePath) {
            window.electronAPI.shell.openInEditor(activeWorkspacePath);
          }
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
      ...activePorts.map((p): CommandItem => {
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
            addBrowserSession(url);
            onClose();
          },
        };
      }),
    ];
  }, [
    addSession,
    addBrowserSession,
    closePane,
    closeSession,
    splitPane,
    splitWithContent,
    selectNextSession,
    selectPrevSession,
    focusNextPane,
    focusPrevPane,
    toggleSidebar,
    onClose,
    onOpenSettings,
    onOpenFeedback,
    sessions,
    selectedSessionId,
    setShowGhosts,
    bindings,
    activeWorkspacePath,
    activePorts,
    openOrFocusDiff,
  ]);
}
