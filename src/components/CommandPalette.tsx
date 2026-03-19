import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import styles from "./CommandPalette.module.css";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
  onNewWorkspace?: () => void;
}

export function CommandPalette({ open, onClose, onOpenSettings, onNewWorkspace }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const addSession = useAppStore((s) => s.addSession);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const selectNextSession = useAppStore((s) => s.selectNextSession);
  const selectPrevSession = useAppStore((s) => s.selectPrevSession);
  const focusNextPane = useAppStore((s) => s.focusNextPane);
  const ws = useAppStore(selectActiveWorkspace);
  const sessions = ws?.sessions ?? [];
  const selectedSessionId = ws?.selectedSessionId ?? null;
  const closeSession = useAppStore((s) => s.closeSession);
  const zoomIn = useAppStore((s) => s.zoomIn);
  const zoomOut = useAppStore((s) => s.zoomOut);
  const resetZoom = useAppStore((s) => s.resetZoom);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const hasProject = projects.length > 0 && projects[selectedProjectIndex];

  const commands: Command[] = useMemo(
    () => [
      { id: "new-session", label: "New Session", shortcut: "⌘T", action: () => { addSession(); onClose(); } },
      ...(hasProject ? [{ id: "new-workspace", label: `New Workspace${hasProject ? ` (${projects[selectedProjectIndex].name})` : ""}`, action: () => { onNewWorkspace?.(); onClose(); } }] : []),
      { id: "close-pane", label: "Close Pane", shortcut: "⌘W", action: () => { closePane(); onClose(); } },
      { id: "close-session", label: "Close Session", shortcut: "⌘⇧W", action: () => {
        const session = sessions.find(s => s.id === selectedSessionId);
        if (session) closeSession(session.id);
        onClose();
      }},
      { id: "split-h", label: "Split Horizontal", shortcut: "⌘D", action: () => { splitPane("horizontal"); onClose(); } },
      { id: "split-v", label: "Split Vertical", shortcut: "⌘⇧D", action: () => { splitPane("vertical"); onClose(); } },
      { id: "next-session", label: "Next Session", shortcut: "⌘⇧]", action: () => { selectNextSession(); onClose(); } },
      { id: "prev-session", label: "Previous Session", shortcut: "⌘⇧[", action: () => { selectPrevSession(); onClose(); } },
      { id: "next-pane", label: "Next Pane", shortcut: "⌥]", action: () => { focusNextPane(); onClose(); } },
      { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "⌘\\", action: () => { toggleSidebar(); onClose(); } },
      { id: "zoom-in", label: "Zoom In", shortcut: "⌘=", action: () => { zoomIn(); onClose(); } },
      { id: "zoom-out", label: "Zoom Out", shortcut: "⌘-", action: () => { zoomOut(); onClose(); } },
      { id: "zoom-reset", label: "Reset Zoom", shortcut: "⌘0", action: () => { resetZoom(); onClose(); } },
      { id: "settings", label: "Settings", shortcut: "⌘,", action: () => { onOpenSettings?.(); onClose(); } },
    ],
    [addSession, closePane, closeSession, splitPane, selectNextSession, selectPrevSession, focusNextPane, toggleSidebar, zoomIn, zoomOut, resetZoom, onClose, onOpenSettings, onNewWorkspace, sessions, selectedSessionId, hasProject, projects, selectedProjectIndex]
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [query, commands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose]
  );

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      setQuery("");
      setSelectedIndex(0);
      inputRef.current?.focus();
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
        }
      }
    },
    [filtered, selectedIndex]
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.palette}
          onOpenAutoFocus={handleOpenAutoFocus}
        >
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Type a command..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className={styles.list}>
            {filtered.map((cmd, idx) => (
              <div
                key={cmd.id}
                className={`${styles.item} ${idx === selectedIndex ? styles.itemSelected : ""}`}
                onClick={() => cmd.action()}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className={styles.label}>{cmd.label}</span>
                {cmd.shortcut && (
                  <span className={styles.shortcut}>{cmd.shortcut}</span>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className={styles.empty}>No matching commands</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
