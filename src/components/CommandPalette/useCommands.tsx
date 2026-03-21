import { useMemo } from "react";
import type { CommandItem } from "./useWorkspaceCommands";

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
  return useMemo(
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
    ],
  );
}
