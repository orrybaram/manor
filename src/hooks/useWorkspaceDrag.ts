import { useState, useRef, useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { WorkspaceInfo } from "../store/project-store";

const EMPTY_STYLE: React.CSSProperties = {};

export function useWorkspaceDrag({
  workspaces,
  onReorderWorkspaces,
  editingPath,
}: {
  workspaces: WorkspaceInfo[];
  onReorderWorkspaces: (orderedPaths: string[]) => void;
  editingPath: string | null;
}) {
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
      for (let i = 0; i < workspaces.length; i++) {
        const el = itemRefs.current.get(i);
        heights[i] = el
          ? el.getBoundingClientRect().height + WORKSPACE_GAP
          : 36;
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
          for (let i = idx + 1; i < workspaces.length; i++) {
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
            const paths = workspaces.map((ws) => ws.path);
            const [moved] = paths.splice(idx, 1);
            paths.splice(finalDrop, 0, moved);
            onReorderWorkspaces(paths);
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
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("lostpointercapture", onUp);
    },
    [editingPath, workspaces, onReorderWorkspaces],
  );

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

  return {
    dragIndex,
    handleDragStart,
    getTransformStyle,
    justDragged,
    itemRefs,
  };
}
