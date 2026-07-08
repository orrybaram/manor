import { useState, useRef, useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useDragOverlayStore } from "../store/drag-overlay-store";

const EMPTY_STYLE: React.CSSProperties = {};

/**
 * Generic pointer-based vertical list reorder. Modeled on useWorkspaceDrag but
 * keyed by opaque item ids so it works for any ordered list (e.g. project
 * commands). Call handleDragStart from a drag handle's onPointerDown, spread
 * getTransformStyle(idx) onto each row, and register each row via itemRefs.
 */
export function useListDrag({
  ids,
  onReorder,
  gap = 0,
  disabled = false,
}: {
  ids: string[];
  onReorder: (orderedIds: string[]) => void;
  gap?: number;
  disabled?: boolean;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dropIndexRef = useRef<number | null>(null);
  const dragStartY = useRef(0);
  const dragActive = useRef(false);
  const dragCleanedUp = useRef(false);
  const itemRefs = useRef<Map<number, HTMLElement>>(new Map());
  const itemHeights = useRef<number[]>([]);

  const handleDragStart = useCallback(
    (idx: number, e: ReactPointerEvent) => {
      if (disabled) return;
      if (e.button !== 0) return;

      const target = e.currentTarget as HTMLElement;
      dragStartY.current = e.clientY;
      dragActive.current = false;
      dragCleanedUp.current = false;

      // Snapshot item heights (including inter-item gap)
      const heights: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const el = itemRefs.current.get(i);
        heights[i] = el ? el.getBoundingClientRect().height + gap : 36;
      }
      itemHeights.current = heights;

      target.setPointerCapture(e.pointerId);

      const onMove = (ev: globalThis.PointerEvent) => {
        const dy = ev.clientY - dragStartY.current;
        if (!dragActive.current && Math.abs(dy) < 4) return;

        if (!dragActive.current) {
          dragActive.current = true;
          useDragOverlayStore.getState().incrementDragCount();
          setDragIndex(idx);
          setDropIndex(idx);
        }

        setDragOffset(dy);

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
          for (let i = idx + 1; i < ids.length; i++) {
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
        if (dragCleanedUp.current) return;
        dragCleanedUp.current = true;

        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("lostpointercapture", onUp);

        if (dragActive.current) {
          useDragOverlayStore.getState().decrementDragCount();
          const finalDrop = dropIndexRef.current ?? idx;
          if (finalDrop !== idx) {
            const next = [...ids];
            const [moved] = next.splice(idx, 1);
            next.splice(finalDrop, 0, moved);
            onReorder(next);
          }
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
    [disabled, ids, onReorder, gap],
  );

  const getTransformStyle = (idx: number): React.CSSProperties => {
    if (dragIndex === null || dropIndex === null) return EMPTY_STYLE;
    const h = itemHeights.current[dragIndex] || 36;
    if (idx === dragIndex) {
      return {
        transform: `translateY(${dragOffset}px)`,
        zIndex: 10,
        position: "relative",
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

  return {
    dragIndex,
    handleDragStart,
    getTransformStyle,
    itemRefs,
  };
}
