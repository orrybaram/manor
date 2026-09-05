import React, {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Boxes from "lucide-react/dist/esm/icons/boxes";
import House from "lucide-react/dist/esm/icons/house";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useKeybindingsStore } from "../../../store/keybindings-store";
import { useNavigationHistoryStore } from "../../../store/navigation-history-store";
import {
  navigateBack,
  navigateForward,
} from "../../../hooks/useNavigationHistory";
import { formatCombo } from "../../../lib/keybindings";
import {
  HOME_PATH,
  isHomePath,
} from "../../../lib/home";
import { useDragOverlayStore } from "../../../store/drag-overlay-store";
import {
  removeWorktreeWithToast,
  quickMergeWorktreeWithToast,
} from "../../../store/workspace-actions";
import { useBranchWatcher } from "../../../hooks/useBranchWatcher";
import { useDiffWatcher } from "../../../hooks/useDiffWatcher";
import { usePrWatcher } from "../../../hooks/usePrWatcher";
import { ProjectItem } from "../ProjectItem";
import { PortsList } from "../../ports/PortsList";
import { AgentsList } from "../AgentsList";
import { NotificationsPopover } from "../../notifications/NotificationsPopover";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  onShowAgents?: () => void;
  onOpenProjectSettings?: (projectId: string) => void;
  onAddProject?: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { onShowAgents, onOpenProjectSettings, onAddProject } = props;

  const projects = useProjectStore((s) => s.projects);
  const canGoBack = useNavigationHistoryStore((s) => s.canGoBack());
  const canGoForward = useNavigationHistoryStore((s) => s.canGoForward());
  const bindings = useKeybindingsStore((s) => s.bindings);
  const backLabel = bindings["history-back"]
    ? `Back (${formatCombo(bindings["history-back"])})`
    : "Back";
  const forwardLabel = bindings["history-forward"]
    ? `Forward (${formatCombo(bindings["history-forward"])})`
    : "Forward";
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const removeProject = useProjectStore((s) => s.removeProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const renameWorkspace = useProjectStore((s) => s.renameWorkspace);
  const setWorkspaceHidden = useProjectStore((s) => s.setWorkspaceHidden);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const createWorktree = useProjectStore((s) => s.createWorktree);
  const collapsedProjectIds = useProjectStore((s) => s.collapsedProjectIds);
  const toggleProjectCollapsed = useProjectStore(
    (s) => s.toggleProjectCollapsed,
  );
  const setProjectExpanded = useProjectStore((s) => s.setProjectExpanded);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const setSidebarWidth = useProjectStore((s) => s.setSidebarWidth);
  const openOrFocusDiff = useAppStore((s) => s.openOrFocusDiff);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const homeActive = isHomePath(activeWorkspacePath);

  useBranchWatcher();
  useDiffWatcher();
  usePrWatcher();

  const handleAddProject = onAddProject ?? (() => { });

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
          useDragOverlayStore.getState().incrementDragCount();
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
          useDragOverlayStore.getState().decrementDragCount();
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
      useDragOverlayStore.getState().incrementDragCount();

      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.max(160, Math.min(400, ev.clientX));
        setSidebarWidth(newWidth);
      };

      const cleanup = () => {
        useDragOverlayStore.getState().decrementDragCount();
        setIsResizing(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [setSidebarWidth],
  );

  return (
    <div
      ref={sidebarRef}
      className={styles.sidebar}
      style={{ width: sidebarWidth }}
    >
      <div className={styles.titlebar}>
        <div className={styles.navControls}>
          <Tooltip label={backLabel}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.navButton}
              onClick={() => navigateBack()}
              disabled={!canGoBack}
              aria-label="Navigate back"
            >
              <ArrowLeft size={12} />
            </Button>
          </Tooltip>
          <Tooltip label={forwardLabel}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.navButton}
              onClick={() => navigateForward()}
              disabled={!canGoForward}
              aria-label="Navigate forward"
            >
              <ArrowRight size={12} />
            </Button>
          </Tooltip>
        </div>
        <div className={styles.titlebarActions}>
          <NotificationsPopover />
        </div>
      </div>
      <div className={styles.content}>
        <div
          className={`${styles.homeRow} ${homeActive ? styles.homeRowActive : ""}`}
          data-testid="home-row"
          onClick={() => setActiveWorkspace(HOME_PATH)}
        >
          <span className={styles.homeIcon}>
            <House size={12} />
          </span>
          <span className={styles.homeLabel}>Home</span>
        </div>
        <div>
          <ContextMenu.Root>
            <ContextMenu.Trigger asChild>
              <div
                className={styles.sectionHeader}
                style={{ cursor: "pointer" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <Boxes size={12} />
                  Projects
                </span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={styles.contextMenu}>
                <ContextMenu.Item
                  className={styles.contextMenuItem}
                  onSelect={handleAddProject}
                >
                  Add Project
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
          <>
            {projects.length === 0 && (
              <div className={styles.empty}>
                No projects yet.
                <br />
                <Button variant="link" onClick={handleAddProject}>
                  Open a folder
                </Button>
              </div>
            )}
            <div className={styles.projectsScroll}>
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
                        projDragIndex === idx
                          ? styles.projectDragging
                          : undefined
                      }
                    >
                      <ProjectItem
                        project={project}
                        isSelected={!homeActive && idx === selectedProjectIndex}
                        collapsed={collapsedProjectIds.has(project.id)}
                        onToggleCollapsed={() => {
                          if (!projJustDragged.current)
                            toggleProjectCollapsed(project.id);
                        }}
                        onSelect={() => {
                          if (projJustDragged.current) return;
                          selectProject(idx);
                          setProjectExpanded(project.id);
                          const wsIdx = project.selectedWorkspaceIndex;
                          selectWorkspace(project.id, wsIdx >= 0 ? wsIdx : 0);
                        }}
                        onRemove={() => removeProject(project.id)}
                        onSelectWorkspace={(wsIdx) => {
                          selectWorkspace(project.id, wsIdx);
                        }}
                        onRemoveWorktree={(ws, deleteBranch) => {
                          removeWorktreeWithToast(project, ws, deleteBranch);
                        }}
                        onQuickMergeWorktree={(ws) => {
                          quickMergeWorktreeWithToast(project, ws);
                        }}
                        onRenameWorkspace={(ws, newName) =>
                          renameWorkspace(project.id, ws.path, newName)
                        }
                        onHideWorkspace={(ws, wsIdx) => {
                          const wasSelected =
                            wsIdx === project.selectedWorkspaceIndex;
                          setWorkspaceHidden(project.id, ws.path, true);
                          if (wasSelected) {
                            const mainIndex = project.workspaces.findIndex(
                              (w) => w.isMain,
                            );
                            if (mainIndex >= 0)
                              selectWorkspace(project.id, mainIndex);
                          }
                        }}
                        onUnhideWorkspace={(ws) =>
                          setWorkspaceHidden(project.id, ws.path, false)
                        }
                        onCreateWorktree={(name, branch, baseBranch, useExistingBranch) =>
                          createWorktree(project.id, name, branch, undefined, undefined, baseBranch, useExistingBranch)
                        }
                        onOpenSettings={() =>
                          onOpenProjectSettings?.(project.id)
                        }
                        onDragStart={(e) => handleProjectDragStart(idx, e)}
                        onOpenDiff={(wsIdx) => {
                          selectWorkspace(project.id, wsIdx);
                          openOrFocusDiff();
                        }}
                      />
                    </div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </>
        </div>
        <AgentsList onShowAll={onShowAgents} />
      </div>
      <PortsList />

      <div
        className={`${styles.resizeHandle} ${isResizing ? styles.resizeHandleActive : ""}`}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
}

const EMPTY_STYLE: React.CSSProperties = {};
