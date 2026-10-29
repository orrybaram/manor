import type { MouseEvent as ReactMouseEvent } from "react";
import { useDragOverlayStore } from "../../../../store/drag-overlay-store";
import { ResizeHandle } from "../../../ui/ResizeHandle/ResizeHandle";
import {
  COLLAPSE_SNAP,
  MAX_WIDTH,
  MIN_WIDTH,
  saveWidth,
  useFileDrawerLayout,
} from "./file-drawer-layout";
import styles from "./FileDrawer.module.css";

/**
 * One drag across both states, as the app sidebar's edge: wider than
 * `COLLAPSE_SNAP` the pointer sets the drawer's width; narrower, the drawer
 * collapses into the strip. The drag can cross back and forth without
 * letting go.
 */
function startEdgeDrag(
  e: ReactMouseEvent,
  open: boolean,
  onOpen: () => void,
  onCollapse: () => void,
) {
  if (e.button !== 0) return;
  e.preventDefault();
  useDragOverlayStore.getState().incrementDragCount();
  useFileDrawerLayout.setState({ dragging: true });

  const startX = e.clientX;
  // The width to come back to after collapsing, rather than the minimum
  // the drag passed through on its way into the strip.
  const restoreWidth = useFileDrawerLayout.getState().width;
  const startWidth = open ? restoreWidth : 0;
  let isOpen = open;

  const onMouseMove = (ev: MouseEvent) => {
    const raw = startWidth + (ev.clientX - startX);
    if (raw < COLLAPSE_SNAP) {
      if (isOpen) {
        useFileDrawerLayout.setState({ width: restoreWidth });
        onCollapse();
        isOpen = false;
      }
      return;
    }
    if (!isOpen) {
      onOpen();
      isOpen = true;
    }
    useFileDrawerLayout.setState({
      width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, raw)),
    });
  };

  const cleanup = () => {
    useDragOverlayStore.getState().decrementDragCount();
    useFileDrawerLayout.setState({ dragging: false });
    saveWidth();
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", cleanup);
    window.removeEventListener("blur", cleanup);
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", cleanup);
  window.addEventListener("blur", cleanup);
}

/**
 * The drawer's right edge, or the strip's while it is collapsed: the same
 * handle and the same drag, so the drawer resizes, collapses and opens
 * from one edge.
 */
export function FileDrawerResizeHandle({
  open,
  onOpen,
  onCollapse,
}: {
  open: boolean;
  onOpen: () => void;
  onCollapse: () => void;
}) {
  const dragging = useFileDrawerLayout((s) => s.dragging);
  return (
    <ResizeHandle
      orientation="vertical"
      active={dragging}
      className={styles.resizeHandle}
      data-testid="file-pane-drawer-resize"
      onMouseDown={(e) => startEdgeDrag(e, open, onOpen, onCollapse)}
    />
  );
}
