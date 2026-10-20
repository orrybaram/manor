import { useCallback, useRef, useState } from "react";
import { useDragOverlayStore } from "../store/drag-overlay-store";

type Options = {
  height: number;
  setHeight: (height: number) => void;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  min: number;
  max: number;
};

/**
 * Drag-to-resize for a sidebar section that sits above a top-edge handle and
 * folds when dragged below `min` (Agents, Ports).
 *
 * While dragging, `dragHeight` follows the pointer from the section's current
 * visible height — 0 when folded — so opening a folded section slides it up
 * instead of snapping to its saved height. The fold/unfold decision and the
 * persisted height are only committed on release.
 *
 * Released below `min`, the section folds from the height it was dragged to:
 * that height is held while it's folded (and while `Collapse` animates it
 * shut), rather than jumping back to the saved height first.
 */
export function useCollapsibleResize(options: Options) {
  const { height, setHeight, collapsed, setCollapsed, min, max } = options;
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [foldedFrom, setFoldedFrom] = useState<number | null>(null);
  // Forget it once the section opens again, so a later fold from the
  // header animates from the saved height.
  if (!collapsed && foldedFrom !== null) setFoldedFrom(null);
  const startY = useRef(0);
  const startHeight = useRef(0);
  const latest = useRef(0);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      useDragOverlayStore.getState().incrementDragCount();
      startY.current = e.clientY;
      startHeight.current = collapsed ? 0 : height;
      latest.current = startHeight.current;
      setFoldedFrom(null);
      setDragHeight(startHeight.current);

      const onMouseMove = (ev: MouseEvent) => {
        // Dragging up grows the section.
        const next = startHeight.current + (startY.current - ev.clientY);
        latest.current = Math.max(0, Math.min(max, next));
        setDragHeight(latest.current);
      };

      const cleanup = () => {
        useDragOverlayStore.getState().decrementDragCount();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
        if (latest.current < min) {
          setFoldedFrom(latest.current);
          setCollapsed(true);
        } else {
          setHeight(latest.current);
          setCollapsed(false);
        }
        setDragHeight(null);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [collapsed, height, setHeight, setCollapsed, min, max],
  );

  const isResizing = dragHeight !== null;
  return {
    isResizing,
    /** Whether the section body should render (open, or mid-drag). */
    showBody: isResizing || !collapsed,
    /**
     * Height for the section body: the live drag height; the height a drag
     * folded it from, while folded; else the saved one.
     */
    bodyHeight: dragHeight ?? (collapsed && foldedFrom !== null ? foldedFrom : height),
    onResizeStart,
  };
}
