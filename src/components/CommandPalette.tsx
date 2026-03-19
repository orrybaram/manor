import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { House, FolderGit2 } from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useListKeyboardNav } from "../hooks/useListKeyboardNav";
import styles from "./CommandPalette.module.css";

interface Command {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  group?: string;
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
  const focusPrevPane = useAppStore((s) => s.focusPrevPane);
  const ws = useAppStore(selectActiveWorkspace);
  const sessions = ws?.sessions ?? [];
  const selectedSessionId = ws?.selectedSessionId ?? null;
  const closeSession = useAppStore((s) => s.closeSession);
  const zoomIn = useAppStore((s) => s.zoomIn);
  const zoomOut = useAppStore((s) => s.zoomOut);
  const resetZoom = useAppStore((s) => s.resetZoom);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const toggleSidebar = useProjectStore((s) => s.toggleSidebar);
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const hasProject = projects.length > 0 && projects[selectedProjectIndex];

  const workspaceCommands: Command[] = useMemo(() => {
    const cmds: Command[] = [];
    for (const project of projects) {
      for (let wi = 0; wi < project.workspaces.length; wi++) {
        const workspace = project.workspaces[wi];
        const isActive = workspace.path === activeWorkspacePath;
        if (isActive) continue;
        const displayName = workspace.name || workspace.branch || "main";
        cmds.push({
          id: `ws-${project.id}-${wi}`,
          label: displayName,
          icon: workspace.isMain ? <House size={14} /> : <FolderGit2 size={14} />,
          group: project.name,
          action: () => {
            selectWorkspace(project.id, wi);
            setActiveWorkspace(workspace.path);
            onClose();
          },
        });
      }
    }
    return cmds;
  }, [projects, activeWorkspacePath, selectWorkspace, setActiveWorkspace, onClose]);

  const commands: Command[] = useMemo(
    () => [
      { id: "new-session", label: "New Session", shortcut: "⌘T", action: () => { addSession(); onClose(); } },
      ...(hasProject ? [{ id: "new-workspace", label: "New Workspace", action: () => { onNewWorkspace?.(); onClose(); } }] : []),
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
      { id: "next-pane", label: "Next Pane", shortcut: "⌘]", action: () => { focusNextPane(); onClose(); } },
      { id: "prev-pane", label: "Previous Pane", shortcut: "⌘[", action: () => { focusPrevPane(); onClose(); } },
      { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "⌘\\", action: () => { toggleSidebar(); onClose(); } },
      { id: "zoom-in", label: "Zoom In", shortcut: "⌘=", action: () => { zoomIn(); onClose(); } },
      { id: "zoom-out", label: "Zoom Out", shortcut: "⌘-", action: () => { zoomOut(); onClose(); } },
      { id: "zoom-reset", label: "Reset Zoom", shortcut: "⌘0", action: () => { resetZoom(); onClose(); } },
      { id: "settings", label: "Settings", shortcut: "⌘,", action: () => { onOpenSettings?.(); onClose(); } },
      ...workspaceCommands,
    ],
    [addSession, closePane, closeSession, splitPane, selectNextSession, selectPrevSession, focusNextPane, focusPrevPane, toggleSidebar, zoomIn, zoomOut, resetZoom, onClose, onOpenSettings, onNewWorkspace, sessions, selectedSessionId, hasProject, projects, selectedProjectIndex, workspaceCommands]
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      (c.group && c.group.toLowerCase().includes(q))
    );
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

  const handleCloseAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      // Refocus the active terminal pane's xterm textarea
      const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      textarea?.focus();
    },
    []
  );

  const handleSelect = useCallback(
    (index: number) => { filtered[index]?.action(); },
    [filtered]
  );

  const handleKeyDown = useListKeyboardNav(
    filtered.length,
    selectedIndex,
    setSelectedIndex,
    handleSelect,
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.palette}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
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
            {filtered.map((cmd, idx) => {
              const prevGroup = idx > 0 ? filtered[idx - 1].group : undefined;
              const showGroup = cmd.group && cmd.group !== prevGroup;
              return (
                <div key={cmd.id}>
                  {showGroup && (
                    <div className={styles.groupHeader}>{cmd.group}</div>
                  )}
                  <div
                    className={`${styles.item} ${idx === selectedIndex ? styles.itemSelected : ""}`}
                    onClick={() => cmd.action()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    {cmd.icon && <span className={styles.icon}>{cmd.icon}</span>}
                    <span className={styles.label}>{cmd.label}</span>
                    {cmd.shortcut && (
                      <span className={styles.shortcut}>{cmd.shortcut}</span>
                    )}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className={styles.empty}>No matching commands</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
