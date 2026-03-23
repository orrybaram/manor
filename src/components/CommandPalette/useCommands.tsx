import { useMemo } from "react";
import type { CommandItem } from "./useWorkspaceCommands";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { formatCombo } from "../../lib/keybindings";

interface UseCommandsParams {
  addSession: () => void;
  closePane: () => void;
  closeSession: (sessionId: string) => void;
  splitPane: (direction: "horizontal" | "vertical") => void;
  selectNextSession: () => void;
  selectPrevSession: () => void;
  focusNextPane: () => void;
  focusPrevPane: () => void;
  toggleSidebar: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  onClose: () => void;
  onOpenSettings?: () => void;
  sessions: { id: string }[];
  selectedSessionId: string | null;
  setShowGhosts: (show: boolean) => void;
}

export function useCommands({
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
}: UseCommandsParams): CommandItem[] {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const platform = navigator.platform.toLowerCase().includes("mac") ? "mac" as const : "other" as const;
  const fmt = (id: string) => bindings[id] ? formatCombo(bindings[id], platform) : undefined;

  return useMemo(
    () => [
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
        shortcut: fmt("split-h"),
        action: () => {
          splitPane("horizontal");
          onClose();
        },
      },
      {
        id: "split-v",
        label: "Split Vertical",
        shortcut: fmt("split-v"),
        action: () => {
          splitPane("vertical");
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
        id: "zoom-in",
        label: "Zoom In",
        shortcut: fmt("zoom-in"),
        action: () => {
          zoomIn();
          onClose();
        },
      },
      {
        id: "zoom-out",
        label: "Zoom Out",
        shortcut: fmt("zoom-out"),
        action: () => {
          zoomOut();
          onClose();
        },
      },
      {
        id: "zoom-reset",
        label: "Reset Zoom",
        shortcut: fmt("zoom-reset"),
        action: () => {
          resetZoom();
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
        id: "ghosts",
        label: "Ghosts!?",
        icon: <span>👻</span>,
        action: () => {
          onClose();
          setShowGhosts(true);
          setTimeout(() => setShowGhosts(false), 5000);
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
      setShowGhosts,
      bindings,
    ],
  );
}
