import React, { useEffect, useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, ChevronDown, ChevronRight, ExternalLink, House, FolderGit2, EthernetPort, Boxes } from "lucide-react";
import { useProjectStore, type ProjectInfo, type WorkspaceInfo } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { removeWorktreeWithToast } from "../store/workspace-actions";
import { usePortsData, type WorkspacePortGroup } from "../hooks/usePortsData";
import { useBranchWatcher } from "../hooks/useBranchWatcher";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const addProjectFromDirectory = useProjectStore((s) => s.addProjectFromDirectory);
  const removeProject = useProjectStore((s) => s.removeProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const renameWorkspace = useProjectStore((s) => s.renameWorkspace);
  const reorderWorkspaces = useProjectStore((s) => s.reorderWorkspaces);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const createWorktree = useProjectStore((s) => s.createWorktree);
  const collapsedProjectIds = useProjectStore((s) => s.collapsedProjectIds);
  const toggleProjectCollapsed = useProjectStore((s) => s.toggleProjectCollapsed);
  const setProjectExpanded = useProjectStore((s) => s.setProjectExpanded);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const loadPersistedLayout = useAppStore((s) => s.loadPersistedLayout);

  useBranchWatcher();

  useEffect(() => {
    // Load persisted layout FIRST so setActiveWorkspace can restore old pane IDs
    loadPersistedLayout().then(() => {
      loadProjects().then(() => {
        const { projects, selectedProjectIndex } = useProjectStore.getState();
        const project = projects[selectedProjectIndex];
        if (project) {
          const ws =
            project.workspaces[project.selectedWorkspaceIndex] ??
            project.workspaces[0];
          if (ws) setActiveWorkspace(ws.path);
        }
      });
    });
  }, [loadProjects, loadPersistedLayout, setActiveWorkspace]);

  const handleAddProject = addProjectFromDirectory;

  // Project drag-and-drop state
  const [projDragIndex, setProjDragIndex] = useState<number | null>(null);
  const [projDropIndex, setProjDropIndex] = useState<number | null>(null);
  const [projDragOffset, setProjDragOffset] = useState(0);
  const projDropIndexRef = useRef<number | null>(null);
  const projDragStartY = useRef(0);
  const projDragActive = useRef(false);
  const projDragCleanedUp = useRef(false);
  const projJustDragged = useRef(false);
  const projItemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const projItemHeights = useRef<number[]>([]);

  const handleProjectDragStart = useCallback(
    (idx: number, e: ReactPointerEvent) => {
      if (e.button !== 0) return;

      const target = e.currentTarget as HTMLElement;
      projDragStartY.current = e.clientY;
      projDragActive.current = false;
      projDragCleanedUp.current = false;

      const heights: number[] = [];
      for (let i = 0; i < projects.length; i++) {
        const el = projItemRefs.current.get(i);
        heights[i] = el ? el.getBoundingClientRect().height : 40;
      }
      projItemHeights.current = heights;

      target.setPointerCapture(e.pointerId);

      const onMove = (ev: globalThis.PointerEvent) => {
        const dy = ev.clientY - projDragStartY.current;
        if (!projDragActive.current && Math.abs(dy) < 4) return;

        if (!projDragActive.current) {
          projDragActive.current = true;
          setProjDragIndex(idx);
          setProjDropIndex(idx);
        }

        setProjDragOffset(dy);

        let offset = 0;
        let targetIdx = idx;
        if (dy < 0) {
          for (let i = idx - 1; i >= 0; i--) {
            offset -= projItemHeights.current[i];
            if (dy < offset + projItemHeights.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        } else {
          for (let i = idx + 1; i < projects.length; i++) {
            offset += projItemHeights.current[i];
            if (dy > offset - projItemHeights.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        }
        if (projDropIndexRef.current !== targetIdx) {
          projDropIndexRef.current = targetIdx;
          setProjDropIndex(targetIdx);
        }
      };

      const onUp = () => {
        if (projDragCleanedUp.current) return;
        projDragCleanedUp.current = true;

        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("lostpointercapture", onUp);

        if (projDragActive.current) {
          projJustDragged.current = true;
          const finalDrop = projDropIndexRef.current ?? idx;
          if (finalDrop !== idx) {
            const ids = projects.map((p) => p.id);
            const [moved] = ids.splice(idx, 1);
            ids.splice(finalDrop, 0, moved);
            reorderProjects(ids);
          }
          requestAnimationFrame(() => { projJustDragged.current = false; });
        }
        projDragActive.current = false;
        projDropIndexRef.current = null;
        setProjDragIndex(null);
        setProjDropIndex(null);
        setProjDragOffset(0);
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("lostpointercapture", onUp);
    },
    [projects, reorderProjects]
  );

  const getProjectTransformStyle = (idx: number): React.CSSProperties => {
    if (projDragIndex === null || projDropIndex === null) return EMPTY_STYLE;
    const h = projItemHeights.current[projDragIndex] || 40;
    if (idx === projDragIndex) {
      return {
        transform: `translateY(${projDragOffset}px)`,
        zIndex: 10,
        position: "relative",
      };
    }
    if (projDragIndex === projDropIndex) return { transition: "transform 150ms ease" };
    if (
      (projDropIndex > projDragIndex && idx > projDragIndex && idx <= projDropIndex) ||
      (projDropIndex < projDragIndex && idx < projDragIndex && idx >= projDropIndex)
    ) {
      const direction = projDropIndex > projDragIndex ? -1 : 1;
      return {
        transform: `translateY(${direction * h}px)`,
        transition: "transform 150ms ease",
      };
    }
    return { transition: "transform 150ms ease" };
  };

  // Resizable sidebar
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);

      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.max(160, Math.min(400, ev.clientX));
        setSidebarWidth(newWidth);
      };

      const onMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [setSidebarWidth]
  );

  const selectedProject = projects[selectedProjectIndex] as
    | ProjectInfo
    | undefined;

  return (
    <div
      ref={sidebarRef}
      className={styles.sidebar}
      style={{ width: sidebarWidth }}
    >
      <div className={styles.titlebar} />
      <div className={styles.content}>
        <div>
          <div className={styles.sectionHeader}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Boxes size={12} />Projects</span>
            <button className={styles.action} onClick={handleAddProject}>
              <Plus size={14} />
            </button>
          </div>
          {projects.length === 0 && (
            <div className={styles.empty}>
              No projects yet.
              <br />
              <button className={styles.link} onClick={handleAddProject}>
                Open a folder
              </button>
            </div>
          )}
          <div className={styles.projects}>
          {projects.map((project, idx) => (
            <React.Fragment key={project.id}>
              {idx > 0 && <div className={styles.projectSeparator} />}
              <div
                ref={(el) => {
                  if (el) projItemRefs.current.set(idx, el);
                  else projItemRefs.current.delete(idx);
                }}
                style={getProjectTransformStyle(idx)}
                className={projDragIndex === idx ? styles.projectDragging : undefined}
              >
              <ProjectItem
                project={project}
                isSelected={idx === selectedProjectIndex}
                collapsed={collapsedProjectIds.has(project.id)}
                onToggleCollapsed={() => {
                  if (!projJustDragged.current) toggleProjectCollapsed(project.id);
                }}
                onSelect={() => {
                  if (projJustDragged.current) return;
                  selectProject(idx);
                  setProjectExpanded(project.id);
                  const ws =
                    project.workspaces[project.selectedWorkspaceIndex] ??
                    project.workspaces[0];
                  if (ws) setActiveWorkspace(ws.path);
                }}
                onRemove={() => removeProject(project.id)}
                onSelectWorkspace={(wsIdx) => {
                  selectWorkspace(project.id, wsIdx);
                  const ws = project.workspaces[wsIdx];
                  if (ws) setActiveWorkspace(ws.path);
                }}
                onRemoveWorktree={(ws, deleteBranch) => {
                  removeWorktreeWithToast(project, ws, deleteBranch);
                }}
                onRenameWorkspace={(ws, newName) => renameWorkspace(project.id, ws.path, newName)}
                onReorderWorkspaces={(orderedPaths) => reorderWorkspaces(project.id, orderedPaths)}
                onCreateWorktree={(name, branch) => createWorktree(project.id, name, branch)}
                onDragStart={(e) => handleProjectDragStart(idx, e)}
              />
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
      </div>
      <PortsList />

      <div
        className={`${styles.resizeHandle} ${isResizing ? styles.resizeHandleActive : ""}`}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
}

function PortsList() {
  const { workspacePortGroups, totalPortCount } = usePortsData();
  const [collapsed, setCollapsed] = useState(false);

  if (totalPortCount === 0) return null;

  return (
    <div className={styles.portsSection}>
      <div
        className={styles.sectionHeader}
        style={{ cursor: "pointer" }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            className={styles.projectChevron}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <EthernetPort size={12} />Ports
          <span className={styles.portCount}>{totalPortCount}</span>
        </span>
      </div>
      {!collapsed && (
        <div className={styles.portGroups}>
          {workspacePortGroups.map((group) => (
            <PortGroup key={group.workspacePath} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function PortGroup({ group }: { group: WorkspacePortGroup }) {
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);

  const handleSelectWorkspace = useCallback(() => {
    const projects = useProjectStore.getState().projects;
    for (const project of projects) {
      const wsIndex = project.workspaces.findIndex(
        (ws) => ws.path === group.workspacePath
      );
      if (wsIndex >= 0) {
        selectWorkspace(project.id, wsIndex);
        setActiveWorkspace(group.workspacePath);
        break;
      }
    }
  }, [group.workspacePath, selectWorkspace, setActiveWorkspace]);

  return (
    <div className={styles.portGroup}>
      {group.branch && (
        <div
          className={styles.portGroupHeader}
          onClick={handleSelectWorkspace}
          style={{ cursor: "pointer" }}
        >
          <span className={styles.portGroupBranch}>
            {group.branch}
            {group.isMain && group.projectName && (
              <span className={styles.portGroupProject}> · {group.projectName}</span>
            )}
          </span>
        </div>
      )}
      {group.ports.map((port) => (
        <PortBadge key={port.port} port={port} />
      ))}
    </div>
  );
}

function PortBadge({ port }: { port: import("../electron.d.ts").ActivePort }) {
  const handleOpen = useCallback(() => {
    window.electronAPI.openExternal(`http://localhost:${port.port}`);
  }, [port.port]);

  return (
    <div
      className={styles.portBadge}
      title={`Open localhost:${port.port}`}
      onClick={handleOpen}
      style={{ cursor: "pointer" }}
    >
      <span className={styles.portNumber}>{port.port}</span>
      <span className={styles.portProcess}>{port.processName}</span>
      <ExternalLink size={12} className={styles.portOpen} />
    </div>
  );
}

const EMPTY_STYLE: React.CSSProperties = {};

function ProjectItem({
  project,
  isSelected,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onRemove,
  onSelectWorkspace,
  onRemoveWorktree,
  onRenameWorkspace,
  onReorderWorkspaces,
  onCreateWorktree,
  onDragStart,
}: {
  project: ProjectInfo;
  isSelected: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onSelectWorkspace: (index: number) => void;
  onRemoveWorktree: (ws: WorkspaceInfo, deleteBranch: boolean) => void;
  onRenameWorkspace: (ws: WorkspaceInfo, newName: string) => void;
  onReorderWorkspaces: (orderedPaths: string[]) => void;
  onCreateWorktree: (name: string, branch: string) => void;
  onDragStart?: (e: ReactPointerEvent) => void;
}) {
  const expanded = !collapsed;
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] = useState<WorkspaceInfo | null>(null);
  const [deleteBranchChecked, setDeleteBranchChecked] = useState(
    () => localStorage.getItem("manor:deleteBranchOnWorktreeRemove") === "true"
  );
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);

  // Drag-and-drop state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dropIndexRef = useRef<number | null>(null);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);
  const dragCleanedUp = useRef(false);
  const justDragged = useRef(false);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const itemHeights = useRef<number[]>([]);

  const startRename = useCallback((ws: WorkspaceInfo) => {
    setEditingPath(ws.path);
    setEditValue(ws.name || ws.branch || "");
  }, []);

  const commitRename = useCallback(
    (ws: WorkspaceInfo) => {
      setEditingPath(null);
      onRenameWorkspace(ws, editValue);
    },
    [editValue, onRenameWorkspace]
  );

  useEffect(() => {
    if (editingPath && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingPath]);

  const handleDragStart = useCallback(
    (idx: number, e: ReactPointerEvent) => {
      if (editingPath) return;
      // Only handle left mouse button
      if (e.button !== 0) return;

      const target = e.currentTarget as HTMLElement;
      dragStartY.current = e.clientY;
      dragActive.current = false;
      dragCleanedUp.current = false;

      // Snapshot item heights (gap matches .workspaces CSS gap)
      const WORKSPACE_GAP = 8;
      const heights: number[] = [];
      for (let i = 0; i < project.workspaces.length; i++) {
        const el = itemRefs.current.get(i);
        heights[i] = el ? el.getBoundingClientRect().height + WORKSPACE_GAP : 36;
      }
      itemHeights.current = heights;

      // Use pointer capture so we get events even outside the element
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: globalThis.PointerEvent) => {
        const dy = ev.clientY - dragStartY.current;
        if (!dragActive.current && Math.abs(dy) < 4) return;

        if (!dragActive.current) {
          dragActive.current = true;
          setDragIndex(idx);
          setDropIndex(idx);
        }

        setDragOffset(dy);

        // Calculate which index we're over
        let offset = 0;
        let targetIdx = idx;
        if (dy < 0) {
          for (let i = idx - 1; i >= 0; i--) {
            offset -= itemHeights.current[i];
            if (dy < offset + itemHeights.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        } else {
          for (let i = idx + 1; i < project.workspaces.length; i++) {
            offset += itemHeights.current[i];
            if (dy > offset - itemHeights.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        }
        if (dropIndexRef.current !== targetIdx) {
          dropIndexRef.current = targetIdx;
          setDropIndex(targetIdx);
        }
      };

      const onUp = () => {
        // Guard against double-fire (pointerup + lostpointercapture)
        if (dragCleanedUp.current) return;
        dragCleanedUp.current = true;

        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("lostpointercapture", onUp);

        if (dragActive.current) {
          justDragged.current = true;
          const finalDrop = dropIndexRef.current ?? idx;
          if (finalDrop !== idx) {
            const paths = project.workspaces.map((ws) => ws.path);
            const [moved] = paths.splice(idx, 1);
            paths.splice(finalDrop, 0, moved);
            onReorderWorkspaces(paths);
          }
          requestAnimationFrame(() => { justDragged.current = false; });
        }
        dragActive.current = false;
        dropIndexRef.current = null;
        setDragIndex(null);
        setDropIndex(null);
        setDragOffset(0);
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("lostpointercapture", onUp);
    },
    [editingPath, project.workspaces, onReorderWorkspaces]
  );

  // Compute transform offsets for smooth animation
  const getTransformStyle = (idx: number): React.CSSProperties => {
    if (dragIndex === null || dropIndex === null) return EMPTY_STYLE;
    const h = itemHeights.current[dragIndex] || 36;
    if (idx === dragIndex) {
      return {
        transform: `translateY(${dragOffset}px)`,
        zIndex: 10,
      };
    }
    if (dragIndex === dropIndex) return { transition: "transform 150ms ease" };
    if (
      (dropIndex > dragIndex && idx > dragIndex && idx <= dropIndex) ||
      (dropIndex < dragIndex && idx < dragIndex && idx >= dropIndex)
    ) {
      const direction = dropIndex > dragIndex ? -1 : 1;
      return {
        transform: `translateY(${direction * h}px)`,
        transition: "transform 150ms ease",
      };
    }
    return { transition: "transform 150ms ease" };
  };

  return (
    <div className={styles.project}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={styles.projectHeader}
            onClick={() => {
              onToggleCollapsed();
            }}
            onPointerDown={onDragStart}
            style={{ touchAction: "none" }}
          >
            <span className={styles.projectChevron}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
            <span className={styles.projectName} title={project.path}>{project.name}</span>
            <button
              className={styles.projectAction}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setNewWorkspaceOpen(true);
              }}
              title="New Workspace"
            >
              <Plus size={12} />
            </button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => setNewWorkspaceOpen(true)}
            >
              New Workspace
            </ContextMenu.Item>
            <ContextMenu.Item
              className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
              onSelect={() => setConfirmRemove(true)}
            >
              Remove Project
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {expanded && (
        <div className={styles.workspaces}>
          {project.workspaces.map((ws, idx) => {
            const isEditing = editingPath === ws.path;
            const displayName = ws.isMain ? (ws.name || "local") : (ws.name || ws.branch || "main");
            const isDragging = dragIndex === idx;

            const workspaceEl = (
              <div
                key={ws.path}
                ref={(el) => {
                  if (el) itemRefs.current.set(idx, el);
                  else itemRefs.current.delete(idx);
                }}
                className={`${styles.workspace} ${
                  isSelected && idx === project.selectedWorkspaceIndex ? styles.workspaceActive : ""
                } ${isDragging ? styles.workspaceDragging : ""}`}
                style={getTransformStyle(idx)}
                onClick={() => {
                  if (!justDragged.current) onSelectWorkspace(idx);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(ws);
                }}
                onPointerDown={(e) => handleDragStart(idx, e)}
              >
                {isEditing ? (
                  <input
                    ref={editRef}
                    className={styles.workspaceNameInput}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => {
                      if (editingPath) commitRename(ws);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(ws);
                      if (e.key === "Escape") {
                        setEditingPath(null);
                        e.currentTarget.blur();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className={styles.workspaceIcon}>
                      {ws.isMain ? <House size={12} /> : <FolderGit2 size={12} />}
                    </span>
                    <div className={styles.workspaceLabel}>
                      <span className={styles.workspaceName}>{displayName}</span>
                      <span className={styles.workspaceBranch}>{ws.branch || "main"}</span>
                    </div>
                  </>
                )}
              </div>
            );

            return (
              <ContextMenu.Root key={ws.path}>
                <ContextMenu.Trigger asChild>
                  {workspaceEl}
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content className={styles.contextMenu}>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() => window.electronAPI.openExternal(`file://${ws.path}`)}
                    >
                      Open in Finder
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() => navigator.clipboard.writeText(ws.branch || "main")}
                    >
                      Copy Branch Name
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className={styles.contextMenuItem}
                      onSelect={() => navigator.clipboard.writeText(ws.path)}
                    >
                      Copy Path
                    </ContextMenu.Item>
                    {!ws.isMain && (
                      <>
                        <ContextMenu.Separator className={styles.contextMenuSeparator} />
                        <ContextMenu.Item
                          className={styles.contextMenuItem}
                          onSelect={() => startRename(ws)}
                        >
                          Rename Workspace
                        </ContextMenu.Item>
                        <ContextMenu.Item
                          className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                          onSelect={() => {
                            setConfirmDeleteWorktree(ws);
                          }}
                        >
                          Delete Workspace
                        </ContextMenu.Item>
                      </>
                    )}
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            );
          })}
        </div>
      )}

      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        projects={[project]}
        selectedProjectIndex={0}
        onSubmit={(_projectId, name, branch) => {
          setNewWorkspaceOpen(false);
          onCreateWorktree(name, branch);
        }}
      />

      <Dialog.Root open={confirmRemove} onOpenChange={setConfirmRemove}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.confirmOverlay} />
          <Dialog.Content className={styles.confirmDialog}>
            <Dialog.Title className={styles.confirmTitle}>
              Remove Project
            </Dialog.Title>
            <Dialog.Description className={styles.confirmDescription}>
              Remove <strong>{project.name}</strong> from the sidebar? This won't
              delete any files on disk.
            </Dialog.Description>
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmCancel}
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </button>
              <button
                className={styles.confirmRemove}
                onClick={() => {
                  setConfirmRemove(false);
                  onRemove();
                }}
              >
                Remove
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={confirmDeleteWorktree !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteWorktree(null); }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.confirmOverlay} />
          <Dialog.Content className={styles.confirmDialog}>
            <Dialog.Title className={styles.confirmTitle}>
              Delete Workspace
            </Dialog.Title>
            <Dialog.Description className={styles.confirmDescription}>
              Delete workspace{" "}
              <strong>
                {confirmDeleteWorktree?.name || confirmDeleteWorktree?.branch || ""}
              </strong>
              ? This will remove the worktree from disk.
            </Dialog.Description>
            {confirmDeleteWorktree?.branch && (
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={deleteBranchChecked}
                  onChange={(e) => {
                    setDeleteBranchChecked(e.target.checked);
                    localStorage.setItem("manor:deleteBranchOnWorktreeRemove", String(e.target.checked));
                  }}
                />
                Also delete local branch <strong>{confirmDeleteWorktree.branch}</strong>
              </label>
            )}
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmCancel}
                onClick={() => setConfirmDeleteWorktree(null)}
              >
                Cancel
              </button>
              <button
                className={styles.confirmRemove}
                onClick={() => {
                  const ws = confirmDeleteWorktree;
                  setConfirmDeleteWorktree(null);
                  if (ws) onRemoveWorktree(ws, deleteBranchChecked);
                }}
              >
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
