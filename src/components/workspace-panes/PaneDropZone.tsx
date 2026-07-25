import { useRef, useState, useCallback } from "react";
import { usePaneDrag } from "./PaneDragContext";
import { useAppStore } from "../../store/app-store";
import type { SplitDirection } from "../../store/pane-tree";
import styles from "./PaneLayout/PaneLayout.module.css";

type DropZone = {
  direction: SplitDirection;
  position: "first" | "second";
};

function zoneFromPointer(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): DropZone {
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);

  const normX = Math.abs(dx / rect.width);
  const normY = Math.abs(dy / rect.height);

  if (normX > normY) {
    return {
      direction: "horizontal",
      position: dx < 0 ? "first" : "second",
    };
  }
  return {
    direction: "vertical",
    position: dy < 0 ? "first" : "second",
  };
}

function highlightStyle(zone: DropZone): React.CSSProperties {
  switch (zone.direction) {
    case "horizontal":
      return zone.position === "first"
        ? { left: 0, width: "50%", top: 0, bottom: 0 }
        : { right: 0, width: "50%", top: 0, bottom: 0 };
    case "vertical":
      return zone.position === "first"
        ? { top: 0, height: "50%", left: 0, right: 0 }
        : { bottom: 0, height: "50%", left: 0, right: 0 };
  }
}

function dividerStyle(zone: DropZone): React.CSSProperties {
  switch (zone.direction) {
    case "horizontal":
      return { left: "50%", top: 0, bottom: 0, width: 2, marginLeft: -1 };
    case "vertical":
      return { top: "50%", left: 0, right: 0, height: 2, marginTop: -1 };
  }
}

type PaneDropZoneProps = {
  paneId: string;
};

export function PaneDropZone(props: PaneDropZoneProps) {
  const { paneId } = props;

  const overlayRef = useRef<HTMLDivElement>(null);
  const { endDrag } = usePaneDrag();
  const movePaneToTarget = useAppStore((s) => s.movePaneToTarget);
  const moveTabToPane = useAppStore((s) => s.moveTabToPane);
  const [zone, setZone] = useState<DropZone | null>(null);
  const zoneRef = useRef<DropZone | null>(null);

  // Native drag-and-drop path for TAB and PANE drags. preventDefault in both
  // dragover and drop marks this a valid target, so the source's dragend sees
  // dropEffect "move" and does not tear off a window.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (
      !types.includes("application/x-manor-tab") &&
      !types.includes("application/x-manor-pane")
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const el = overlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const newZone = zoneFromPointer(rect, e.clientX, e.clientY);
    zoneRef.current = newZone;
    setZone(newZone);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const draggedPaneId = e.dataTransfer.getData("application/x-manor-pane");
      const tabId = e.dataTransfer.getData("application/x-manor-tab");
      if (!draggedPaneId && !tabId) return;
      e.preventDefault();
      e.stopPropagation();
      const el = overlayRef.current;
      const currentZone =
        zoneRef.current ??
        (el
          ? zoneFromPointer(el.getBoundingClientRect(), e.clientX, e.clientY)
          : null);
      if (currentZone) {
        if (draggedPaneId) {
          movePaneToTarget(
            draggedPaneId,
            paneId,
            currentZone.direction,
            currentZone.position,
          );
        } else {
          moveTabToPane(
            tabId,
            paneId,
            currentZone.direction,
            currentZone.position,
          );
        }
      }
      setZone(null);
      // Clear the shared drag state here: the split unmounts the source, so
      // Chromium may never fire its dragend — without this the drop overlays
      // stay live and keep highlighting on hover after the drop.
      endDrag();
    },
    [paneId, movePaneToTarget, moveTabToPane, endDrag],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setZone(null);
  }, []);

  return (
    <div
      ref={overlayRef}
      className={styles.dropOverlay}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {zone && (
        <>
          <div
            className={styles.dropZoneHighlight}
            style={highlightStyle(zone)}
          />
          <div className={styles.dropZoneDivider} style={dividerStyle(zone)} />
        </>
      )}
    </div>
  );
}
