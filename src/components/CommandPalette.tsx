import { useMemo, useCallback, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { House, FolderGit2 } from "lucide-react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
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
  onNewWorkspace?: () => void;
}

export function CommandPalette({ open, onClose, onOpenSettings, onNewWorkspace }: CommandPaletteProps) {
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
          icon: workspace.isMain ? <House size={14} /> : <FolderGit2 size={14} />,
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
    }
    return cmds;
  }, [projects, activeWorkspacePath, selectWorkspace, setActiveWorkspace, onClose]);

  const commands: CommandItem[] = useMemo(
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
    ],
    [addSession, closePane, closeSession, splitPane, selectNextSession, selectPrevSession, focusNextPane, focusPrevPane, toggleSidebar, zoomIn, zoomOut, resetZoom, onClose, onOpenSettings, onNewWorkspace, sessions, selectedSessionId, hasProject, projects, selectedProjectIndex]
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

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose]
  );

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
    },
    []
  );

  const handleCloseAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      textarea?.focus();
    },
    []
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
          <Command className={styles.command} loop>
            <Command.Input
              className={styles.input}
              placeholder="Type a command..."
              autoFocus
            />
            <Command.List className={styles.list}>
              <Command.Empty className={styles.empty}>No matching commands</Command.Empty>
              {[...workspaceGroups.entries()].map(([groupName, items]) => (
                <Command.Group key={groupName} heading={groupName} className={styles.group}>
                  {items.map((cmd) => (
                    <Command.Item
                      key={cmd.id}
                      value={`${groupName} ${cmd.label}`}
                      onSelect={cmd.action}
                      className={`${styles.item} ${cmd.isActive ? styles.itemActive : ""}`}
                    >
                      {cmd.icon && <span className={styles.icon}>{cmd.icon}</span>}
                      <span className={styles.label}>{cmd.label}</span>
                      {cmd.isActive && <span className={styles.activeBadge}>current</span>}
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
                    {cmd.icon && <span className={styles.icon}>{cmd.icon}</span>}
                    <span className={styles.label}>{cmd.label}</span>
                    {cmd.shortcut && (
                      <span className={styles.shortcut}>{cmd.shortcut}</span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
