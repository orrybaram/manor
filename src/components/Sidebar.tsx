import React, {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Plus, Boxes } from "lucide-react";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { removeWorktreeWithToast } from "../store/workspace-actions";
import { useBranchWatcher } from "../hooks/useBranchWatcher";
import { useDiffWatcher } from "../hooks/useDiffWatcher";
import { usePrWatcher } from "../hooks/usePrWatcher";
import { useMountEffect } from "../hooks/useMountEffect";
import { ProjectItem } from "./ProjectItem";
import { PortsList } from "./PortsList";
import { TasksList } from "./TasksList";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const addProjectFromDirectory = useProjectStore(
    (s) => s.addProjectFromDirectory,
  );
  const removeProject = useProjectStore((s) => s.removeProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const renameWorkspace = useProjectStore((s) => s.renameWorkspace);
  const reorderWorkspaces = useProjectStore((s) => s.reorderWorkspaces);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const createWorktree = useProjectStore((s) => s.createWorktree);
  const collapsedProjectIds = useProjectStore((s) => s.collapsedProjectIds);
  const toggleProjectCollapsed = useProjectStore(
    (s) => s.toggleProjectCollapsed,
  );
  const setProjectExpanded = useProjectStore((s) => s.setProjectExpanded);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const loadPersistedLayout = useAppStore((s) => s.loadPersistedLayout);

  useBranchWatcher();
  useDiffWatcher();
  usePrWatcher();

  useMountEffect(() => {
    Promise.all([loadPersistedLayout(), loadProjects()]).then(() => {
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
          requestAnimationFrame(() => {
            projJustDragged.current = false;
          });
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
    [projects, reorderProjects],
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
    if (projDragIndex === projDropIndex)
      return { transition: "transform 150ms ease" };
    if (
      (projDropIndex > projDragIndex &&
        idx > projDragIndex &&
        idx <= projDropIndex) ||
      (projDropIndex < projDragIndex &&
        idx < projDragIndex &&
        idx >= projDropIndex)
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
    [setSidebarWidth],
  );

  const _selectedProject = projects[selectedProjectIndex] as
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
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Boxes size={12} />
              Projects
            </span>
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
                  className={
                    projDragIndex === idx ? styles.projectDragging : undefined
                  }
                >
                  <ProjectItem
                    project={project}
                    isSelected={idx === selectedProjectIndex}
                    collapsed={collapsedProjectIds.has(project.id)}
                    onToggleCollapsed={() => {
                      if (!projJustDragged.current)
                        toggleProjectCollapsed(project.id);
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
                    onRenameWorkspace={(ws, newName) =>
                      renameWorkspace(project.id, ws.path, newName)
                    }
                    onReorderWorkspaces={(orderedPaths) =>
                      reorderWorkspaces(project.id, orderedPaths)
                    }
                    onCreateWorktree={(name, branch) =>
                      createWorktree(project.id, name, branch)
                    }
                    onDragStart={(e) => handleProjectDragStart(idx, e)}
                  />
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
      <TasksList />
      <PortsList />

      <div
        className={`${styles.resizeHandle} ${isResizing ? styles.resizeHandleActive : ""}`}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
}

const EMPTY_STYLE: React.CSSProperties = {};
