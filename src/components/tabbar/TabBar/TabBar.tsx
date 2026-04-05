import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import Globe from "lucide-react/dist/esm/icons/globe";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import * as Popover from "@radix-ui/react-popover";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { useAppStore, selectActiveWorkspace } from "../../../store/app-store";
import { useProjectStore } from "../../../store/project-store";
import { useDragOverlayStore } from "../../../store/drag-overlay-store";
import { usePaneDrag } from "../../workspace-panes/PaneDragContext";
import { TabButton } from "../TabButton";
import { TabDragGhost } from "../TabDragGhost";
import styles from "./TabBar.module.css";

const EMPTY_STYLE: React.CSSProperties = {};
const TAB_GAP = 2; // matches .tabs CSS gap

type TabBarProps = {
  onNewTask: () => void;
  panelId?: string;
  workspacePath?: string;
};

export function TabBar(props: TabBarProps) {
  const { onNewTask, panelId, workspacePath } = props;

  const panel = useAppStore((s) => {
    if (panelId && workspacePath) {
      return s.workspaceLayouts[workspacePath]?.panels[panelId] ?? null;
    }
    return selectActiveWorkspace(s);
  });
  const tabs = useMemo(() => panel?.tabs ?? [], [panel?.tabs]);
  const selectedTabId = panel?.selectedTabId ?? null;
  const selectTab = useAppStore((s) => s.selectTab);
  const addTab = useAppStore((s) => s.addTab);
  const addBrowserTab = useAppStore((s) => s.addBrowserTab);
  const requestCloseTab = useAppStore((s) => s.requestCloseTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const pinnedTabIds = useMemo(
    () => panel?.pinnedTabIds ?? [],
    [panel?.pinnedTabIds],
  );

  const ensureFocused = useCallback(() => {
    if (panelId) {
      useAppStore.getState().focusPanel(panelId);
    }
  }, [panelId]);
  const sidebarVisible = useProjectStore((s) => s.sidebarVisible);
  const { drag, startDrag, endDrag } = usePaneDrag();
  const extractPaneToTab = useAppStore((s) => s.extractPaneToTab);

  const tabsRef = useRef<HTMLDivElement>(null);
  const handedOffToPaneDrop = useRef(false);
  const draggedPointerId = useRef(0);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const dragStartX = useRef(0);
  const dragGrabOffset = useRef({ x: 0, y: 0 });
  const dragActive = useRef(false);
  const dragCleanedUp = useRef(false);
  const dropIndexRef = useRef<number | null>(null);
  const justDragged = useRef(false);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const itemWidths = useRef<number[]>([]);

  const handleDragStart = useCallback(
    (idx: number, e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      // Don't start drag when clicking the close button
      const target = e.target as HTMLElement;
      if (target.closest(`.${styles.tabClose}`)) return;

      const tabEl = e.currentTarget as HTMLElement;
      const tabRect = tabEl.getBoundingClientRect();
      dragStartX.current = e.clientX;
      dragGrabOffset.current = {
        x: e.clientX - tabRect.left,
        y: e.clientY - tabRect.top,
      };
      dragActive.current = false;
      dragCleanedUp.current = false;
      draggedPointerId.current = e.pointerId;
      handedOffToPaneDrop.current = false;

      // Snapshot item widths
      const widths: number[] = [];
      for (let i = 0; i < tabs.length; i++) {
        const el = itemRefs.current.get(i);
        widths[i] = el ? el.getBoundingClientRect().width + TAB_GAP : 80;
      }
      itemWidths.current = widths;

      tabEl.setPointerCapture(e.pointerId);

      // Compute drag boundaries: pinned tabs stay in pinned zone, unpinned in unpinned zone
      const pinnedCount = pinnedTabIds.length;
      const isDraggedPinned = pinnedTabIds.includes(tabs[idx].id);
      const minIdx = isDraggedPinned ? 0 : pinnedCount;
      const maxIdx = isDraggedPinned ? pinnedCount - 1 : tabs.length - 1;

      const onMove = (ev: globalThis.PointerEvent) => {
        const dx = ev.clientX - dragStartX.current;
        if (!dragActive.current && Math.abs(dx) < 4) return;

        if (!dragActive.current) {
          dragActive.current = true;
          useDragOverlayStore.getState().incrementDragCount();
          setDragIndex(idx);
          setDropIndex(idx);
        }

        setDragOffset(dx);
        setDragPos({
          x: ev.clientX - dragGrabOffset.current.x,
          y: ev.clientY - dragGrabOffset.current.y,
        });

        let offset = 0;
        let targetIdx = idx;
        if (dx < 0) {
          for (let i = idx - 1; i >= minIdx; i--) {
            offset -= itemWidths.current[i];
            if (dx < offset + itemWidths.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        } else {
          for (let i = idx + 1; i <= maxIdx; i++) {
            offset += itemWidths.current[i];
            if (dx > offset - itemWidths.current[i] / 2) {
              targetIdx = i;
            } else break;
          }
        }
        targetIdx = Math.max(minIdx, Math.min(maxIdx, targetIdx));
        dropIndexRef.current = targetIdx;
        setDropIndex(targetIdx);

        // Check if pointer has left the tab bar area (dragged down into pane area)
        const tabsEl = tabsRef.current;
        if (tabsEl && dragActive.current) {
          const barRect = tabsEl.getBoundingClientRect();
          if (ev.clientY > barRect.bottom + 20) {
            // Release pointer capture so pane drop zones can receive events
            try {
              tabEl.releasePointerCapture(draggedPointerId.current);
            } catch {
              /* pointer may already be released */
            }
            startDrag({ type: "tab", tabId: tabs[idx].id, grabOffset: dragGrabOffset.current });
            handedOffToPaneDrop.current = true;
            // Clean up tab bar drag visuals
            setDragIndex(null);
            setDropIndex(null);
            setDragOffset(0);
            setDragPos(null);

            // Global listener to end drag if user drops outside any pane
            const globalCleanup = () => {
              requestAnimationFrame(() => {
                endDrag();
              });
              document.removeEventListener("pointerup", globalCleanup);
            };
            document.addEventListener("pointerup", globalCleanup);
          }
        }
      };

      const onUp = () => {
        if (handedOffToPaneDrop.current) {
          handedOffToPaneDrop.current = false;
          tabEl.removeEventListener("pointermove", onMove);
          tabEl.removeEventListener("pointerup", onUp);
          tabEl.removeEventListener("lostpointercapture", onUp);
          dragActive.current = false;
          dropIndexRef.current = null;
          setDragIndex(null);
          setDropIndex(null);
          setDragOffset(0);
          setDragPos(null);
          return;
        }

        if (dragCleanedUp.current) return;
        dragCleanedUp.current = true;

        tabEl.removeEventListener("pointermove", onMove);
        tabEl.removeEventListener("pointerup", onUp);
        tabEl.removeEventListener("lostpointercapture", onUp);

        if (dragActive.current) {
          useDragOverlayStore.getState().decrementDragCount();
          justDragged.current = true;
          const finalDrop = dropIndexRef.current ?? idx;
          if (finalDrop !== idx) {
            const ids = tabs.map((s) => s.id);
            const [moved] = ids.splice(idx, 1);
            ids.splice(finalDrop, 0, moved);
            reorderTabs(ids);
          }
          requestAnimationFrame(() => {
            justDragged.current = false;
          });
        }
        dragActive.current = false;
        dropIndexRef.current = null;
        setDragIndex(null);
        setDropIndex(null);
        setDragOffset(0);
        setDragPos(null);
      };

      tabEl.addEventListener("pointermove", onMove);
      tabEl.addEventListener("pointerup", onUp);
      tabEl.addEventListener("lostpointercapture", onUp);
    },
    [tabs, reorderTabs, pinnedTabIds, startDrag, endDrag],
  );

  const getTransformStyle = (idx: number): React.CSSProperties => {
    if (dragIndex === null || dropIndex === null) return EMPTY_STYLE;
    const w = itemWidths.current[dragIndex] || 80;
    if (idx === dragIndex) {
      return {
        transform: `translateX(${dragOffset}px)`,
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
        transform: `translateX(${direction * w}px)`,
        transition: "transform 150ms ease",
      };
    }
    return { transition: "transform 150ms ease" };
  };

  const moveTabToPanel = useAppStore((s) => s.moveTabToPanel);
  const splitPanelWithTab = useAppStore((s) => s.splitPanelWithTab);
  const mergeTabIntoTab = useAppStore((s) => s.mergeTabIntoTab);
  const isDragActive = drag !== null;
  const barRef = useRef<HTMLDivElement>(null);
  const [splitDropHint, setSplitDropHint] = useState(false);
  const [dropTargetTabId, setDropTargetTabId] = useState<string | null>(null);

  const handleTabBarDrop = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      e.stopPropagation();
      setSplitDropHint(false);
      if (drag.type === "pane") {
        extractPaneToTab(drag.paneId, panelId);
      } else if (drag.type === "tab" && panelId) {
        // Drop on right half → split horizontally; left half → move to panel
        const bar = barRef.current;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          const isRightHalf = e.clientX > rect.left + rect.width / 2;
          if (isRightHalf) {
            splitPanelWithTab(drag.tabId, panelId, "horizontal");
          } else {
            moveTabToPanel(drag.tabId, panelId);
          }
        } else {
          moveTabToPanel(drag.tabId, panelId);
        }
      }
      endDrag();
    },
    [drag, extractPaneToTab, moveTabToPanel, splitPanelWithTab, endDrag, panelId],
  );

  const handleTabBarPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag || drag.type !== "tab" || !panelId) {
        setSplitDropHint(false);
        return;
      }
      const bar = barRef.current;
      if (bar) {
        const rect = bar.getBoundingClientRect();
        setSplitDropHint(e.clientX > rect.left + rect.width / 2);
      }
    },
    [drag, panelId],
  );

  const handleTabBarPointerLeave = useCallback(() => {
    setSplitDropHint(false);
    setDropTargetTabId(null);
  }, []);

  const splitPanel = useAppStore((s) => s.splitPanel);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={barRef}
          className={`${styles.tabBar} ${!sidebarVisible ? styles.noSidebar : ""} ${isDragActive ? styles.tabBarDropTarget : ""} ${splitDropHint ? styles.tabBarSplitHint : ""}`}
          onPointerUp={isDragActive ? handleTabBarDrop : undefined}
          onPointerMove={isDragActive ? handleTabBarPointerMove : undefined}
          onPointerLeave={isDragActive ? handleTabBarPointerLeave : undefined}
        >
          <div ref={tabsRef} className={styles.tabs}>
            {tabs.map((tab, idx) => {
              const isPinned = pinnedTabIds.includes(tab.id);
              const isDropTarget = dropTargetTabId === tab.id;
              return (
                <TabButton
                  key={tab.id}
                  tabId={tab.id}
                  isActive={tab.id === selectedTabId}
                  isPinned={isPinned}
                  canClose={true}
                  isDragging={dragIndex === idx}
                  isDropTarget={isDropTarget}
                  onSelect={() => {
                    if (!justDragged.current) {
                      ensureFocused();
                      selectTab(tab.id);
                    }
                  }}
                  onClose={() => {
                    ensureFocused();
                    requestCloseTab(tab.id);
                  }}
                  onTogglePin={() => {
                    ensureFocused();
                    togglePinTab(tab.id);
                  }}
                  onPointerDown={
                    isPinned ? undefined : (e) => handleDragStart(idx, e)
                  }
                  onPointerEnter={
                    isDragActive && drag?.type === "tab" && drag.tabId !== tab.id
                      ? () => setDropTargetTabId(tab.id)
                      : undefined
                  }
                  onPointerLeave={
                    isDragActive && drag?.type === "tab"
                      ? () => setDropTargetTabId((prev) => prev === tab.id ? null : prev)
                      : undefined
                  }
                  onPointerUp={
                    isDragActive && drag?.type === "tab" && drag.tabId !== tab.id
                      ? (e) => {
                          e.stopPropagation();
                          mergeTabIntoTab(drag.tabId, tab.id);
                          endDrag();
                          setDropTargetTabId(null);
                        }
                      : undefined
                  }
                  style={getTransformStyle(idx)}
                  buttonRef={(el) => {
                    if (el) itemRefs.current.set(idx, el);
                    else itemRefs.current.delete(idx);
                  }}
                />
              );
            })}
            <Popover.Root open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <Tooltip label={addMenuOpen ? "" : "New Tab"}>
                <Popover.Anchor asChild>
                  <button
                    className={styles.addButton}
                    onClick={() => { ensureFocused(); addTab(); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setAddMenuOpen(true);
                    }}
                  >
                    <Plus size={14} />
                  </button>
                </Popover.Anchor>
              </Tooltip>
              <Popover.Portal>
                <Popover.Content
                  className={styles.contextMenu}
                  side="bottom"
                  align="center"
                  sideOffset={4}
                >
                  <button
                    className={styles.contextMenuItem}
                    onClick={() => {
                      ensureFocused();
                      addBrowserTab("about:blank");
                      setAddMenuOpen(false);
                    }}
                  >
                    <Globe size={14} />
                    Browser
                  </button>
                  <button
                    className={styles.contextMenuItem}
                    onClick={() => {
                      ensureFocused();
                      onNewTask();
                      setAddMenuOpen(false);
                    }}
                  >
                    <ListTodo size={14} />
                    Task
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <div className={styles.spacer} />
          {dragIndex !== null && dragPos && (
            <TabDragGhost
              tabId={tabs[dragIndex].id}
              x={dragPos.x}
              y={dragPos.y}
            />
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={styles.contextMenu}>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              ensureFocused();
              splitPanel("horizontal");
            }}
          >
            Split Right
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.contextMenuItem}
            onSelect={() => {
              ensureFocused();
              splitPanel("vertical");
            }}
          >
            Split Down
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
