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
  const { drag, endDrag } = usePaneDrag();
  const movePaneToTarget = useAppStore((s) => s.movePaneToTarget);
  const moveTabToPane = useAppStore((s) => s.moveTabToPane);
  const [zone, setZone] = useState<DropZone | null>(null);
  const zoneRef = useRef<DropZone | null>(null);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const el = overlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const newZone = zoneFromPointer(rect, e.clientX, e.clientY);
    zoneRef.current = newZone;
    setZone(newZone);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      let currentZone = zoneRef.current;
      // If pointerMove never fired (fast drag), compute zone from the up event
      if (!currentZone) {
        const el = overlayRef.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          currentZone = zoneFromPointer(rect, e.clientX, e.clientY);
        }
      }
      if (currentZone && drag) {
        if (drag.type === "pane") {
          movePaneToTarget(
            drag.paneId,
            paneId,
            currentZone.direction,
            currentZone.position,
          );
        } else if (drag.type === "tab") {
          moveTabToPane(
            drag.tabId,
            paneId,
            currentZone.direction,
            currentZone.position,
          );
        }
      }
      endDrag();
    },
    [drag, paneId, movePaneToTarget, moveTabToPane, endDrag],
  );

  const handlePointerLeave = useCallback(() => {
    setZone(null);
  }, []);

  return (
    <div
      ref={overlayRef}
      className={styles.dropOverlay}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
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
