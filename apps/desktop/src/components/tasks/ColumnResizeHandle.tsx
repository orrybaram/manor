import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ResizeHandle } from "../ui/ResizeHandle/ResizeHandle";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { clampColumnWidth, type TaskColumnId } from "./task-columns";
import styles from "./TasksView.module.css";

/** How far an arrow key moves the edge. */
const KEY_STEP = 8;

type ColumnResizeHandleProps = {
  column: TaskColumnId;
  /** The column's name, for the handle's label. */
  label: string;
  width: number;
  /**
   * Which edge of the column the handle sits on: `end` left of Title, where
   * the right edge moves; `start` right of Title, where Title gives way and
   * the left edge moves.
   */
  edge: "start" | "end";
  /** Follows the drag without saving. */
  onResize: (column: TaskColumnId, width: number) => void;
  /** Saves where the drag or key press ended. */
  onCommit: (column: TaskColumnId, width: number) => void;
  onReset: (column: TaskColumnId) => void;
};

/**
 * A header's resize edge: drag it, double-click to reset the column, or focus
 * it and use the arrow keys. It sits beside the header's sort button, so
 * grabbing it never sorts.
 */
export function ColumnResizeHandle(props: ColumnResizeHandleProps) {
  const { column, label, width, edge, onResize, onCommit, onReset } = props;

  const [dragging, setDragging] = useState(false);
  // Moving right widens a column by its right edge, narrows it by its left.
  const sign = edge === "end" ? 1 : -1;

  const startDrag = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width;
    let last = startWidth;

    useDragOverlayStore.getState().incrementDragCount();
    setDragging(true);

    const onMouseMove = (ev: MouseEvent) => {
      last = clampColumnWidth(
        column,
        startWidth + sign * (ev.clientX - startX),
      );
      onResize(column, last);
    };
    const cleanup = () => {
      useDragOverlayStore.getState().decrementDragCount();
      setDragging(false);
      onCommit(column, last);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", cleanup);
      window.removeEventListener("blur", cleanup);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", cleanup);
    window.addEventListener("blur", cleanup);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step =
      e.key === "ArrowRight" ? KEY_STEP : e.key === "ArrowLeft" ? -KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    onCommit(column, width + sign * step);
  };

  return (
    <ResizeHandle
      orientation="vertical"
      active={dragging}
      className={`${styles.columnResizeHandle} ${edge === "start" ? styles.columnResizeStart : styles.columnResizeEnd}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      tabIndex={0}
      data-testid={`task-column-resize-${column}`}
      onMouseDown={startDrag}
      onDoubleClick={() => onReset(column)}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
