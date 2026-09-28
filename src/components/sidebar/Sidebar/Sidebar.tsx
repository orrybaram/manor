import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Folders from "lucide-react/dist/esm/icons/folders";
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
import { useSidebarSelectionStore } from "../../../store/sidebar-selection-store";
import {
  handleSidebarRowKeyDown,
  useRovingRows,
} from "../../../lib/sidebar-row";
import { useBranchWatcher } from "../../../hooks/useBranchWatcher";
import { useDiffWatcher } from "../../../hooks/useDiffWatcher";
import { usePrWatcher } from "../../../hooks/usePrWatcher";
import { SidebarEntry } from "../SidebarEntry";
import {
  buildTopLevelEntries,
  expandTopLevelOrder,
  topLevelKeys,
} from "../../../utils/sidebar-items";
import { PortsList } from "../../ports/PortsList";
import { AgentsList } from "../AgentsList";
import { NotificationsPopover } from "../../notifications/NotificationsPopover";
import { SidebarResizeHandle } from "../SidebarResizeHandle/SidebarResizeHandle";
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
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const activeWorkspacePath = useAppStore((s) => s.activeWorkspacePath);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const homeActive = isHomePath(activeWorkspacePath);

  useBranchWatcher();
  useDiffWatcher();
  usePrWatcher();

  const handleAddProject = onAddProject ?? (() => { });

  // One entry per project, or per linked group of projects (ADR-192). The
  // drag below reorders entries; a group's members move together.
  const entries = useMemo(() => buildTopLevelEntries(projects), [projects]);

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
      for (let i = 0; i < entries.length; i++) {
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
          for (let i = idx + 1; i < entries.length; i++) {
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
            const keys = topLevelKeys(entries);
            const [moved] = keys.splice(idx, 1);
            keys.splice(finalDrop, 0, moved);
            reorderProjects(expandTopLevelOrder(keys, entries));
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
    [entries, reorderProjects],
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
  useRovingRows(sidebarRef);

  return (
    <div
      ref={sidebarRef}
      data-focus-region="sidebar"
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
          data-sidebar-row=""
          tabIndex={-1}
          aria-current={homeActive ? "true" : undefined}
          onClick={() => setActiveWorkspace(HOME_PATH)}
          onKeyDown={(e) =>
            handleSidebarRowKeyDown(e, {
              activate: () => setActiveWorkspace(HOME_PATH),
            })
          }
        >
          <span className={styles.homeIcon}>
            <House size={12} />
          </span>
          <span className={styles.homeLabel}>Home</span>
        </div>
        <div className={styles.projectsSection}>
          <ContextMenu.Root>
            <ContextMenu.Trigger asChild>
              {/* Right-click only offers "Add Project", which the app menu
                  also carries; a click does nothing, so no pointer cursor. */}
              <div className={styles.sectionHeader}>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <Folders size={12} />
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
            <div
              className={styles.projectsScroll}
              onClick={(e) => {
                // A click on empty sidebar space, not a row bubbling up,
                // clears the selection (ADR-190 §1).
                if (e.target === e.currentTarget) {
                  useSidebarSelectionStore.getState().clear();
                }
              }}
            >
              <div className={styles.projects}>
                {entries.map((entry, idx) => (
                  <React.Fragment key={entry.key}>
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
                      <SidebarEntry
                        entry={entry}
                        onOpenProjectSettings={onOpenProjectSettings}
                        onDragStart={(e) => handleProjectDragStart(idx, e)}
                        justDraggedRef={projJustDragged}
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

      <SidebarResizeHandle />
    </div>
  );
}

const EMPTY_STYLE: React.CSSProperties = {};
