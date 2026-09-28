import type { MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import { useProjectStore } from "../../../store/project-store";
import { useDragOverlayStore } from "../../../store/drag-overlay-store";
import { RAIL_SNAP_X } from "../../../lib/sidebar-rail";
import styles from "./SidebarResizeHandle.module.css";

const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 400;

/**
 * Whether an edge drag is under way. Kept outside either view so the handle
 * stays lit while the drag swaps the full sidebar and the rail under it.
 */
const useEdgeDragStore = create<{ dragging: boolean }>(() => ({ dragging: false }));

/**
 * One drag across both views (ADR-195): right of `RAIL_SNAP_X` the pointer
 * sets the full sidebar's width; left of it the sidebar is the rail. The
 * drag can cross back and forth without letting go. The listeners live on
 * the document and read the stores directly, so they outlive whichever view
 * started the drag unmounting.
 */
function startEdgeDrag(e: ReactMouseEvent) {
  e.preventDefault();
  useDragOverlayStore.getState().incrementDragCount();
  useEdgeDragStore.setState({ dragging: true });

  // The width to come back to after collapsing, rather than the minimum
  // the drag passed through on its way to the rail.
  const restoreWidth = useProjectStore.getState().sidebarWidth;

  const onMouseMove = (ev: MouseEvent) => {
    const store = useProjectStore.getState();
    if (ev.clientX < RAIL_SNAP_X) {
      if (store.sidebarMode === "full") {
        store.setSidebarWidth(restoreWidth);
        store.setSidebarMode("rail");
      }
      return;
    }
    if (store.sidebarMode === "rail") store.setSidebarMode("full");
    store.setSidebarWidth(
      Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, ev.clientX)),
    );
  };

  const cleanup = () => {
    useDragOverlayStore.getState().decrementDragCount();
    useEdgeDragStore.setState({ dragging: false });
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", cleanup);
    window.removeEventListener("blur", cleanup);
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", cleanup);
  window.addEventListener("blur", cleanup);
}

/**
 * The right edge of the full sidebar and of the rail: the same handle and
 * the same drag, so resizing flows between the two views.
 */
export function SidebarResizeHandle() {
  const dragging = useEdgeDragStore((s) => s.dragging);

  return (
    <div
      className={`${styles.handle} ${dragging ? styles.active : ""}`}
      data-testid="sidebar-resize-handle"
      onMouseDown={startEdgeDrag}
    />
  );
}
