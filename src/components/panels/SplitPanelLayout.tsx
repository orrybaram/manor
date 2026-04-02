import { useCallback, useRef, useState } from "react";
import type { PanelNode } from "../../store/panel-tree";
import type { SplitDirection } from "../../store/pane-tree";
import { useAppStore } from "../../store/app-store";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { PanelLayout } from "./PanelLayout";
import styles from "../workspace-panes/PaneLayout/PaneLayout.module.css";

/** Walk to the first (leftmost/topmost) leaf in a PanelNode tree. */
function firstLeafPanelId(node: PanelNode): string {
  if (node.type === "leaf") return node.panelId;
  return firstLeafPanelId(node.first);
}

type SplitPanelLayoutProps = {
  direction: SplitDirection;
  ratio: number;
  first: PanelNode;
  second: PanelNode;
  workspacePath: string;
  onNewTask: () => void;
};

export function SplitPanelLayout(props: SplitPanelLayoutProps) {
  const { direction, ratio, first, second, workspacePath, onNewTask } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [currentRatio, setCurrentRatio] = useState(ratio);
  const currentRatioRef = useRef(currentRatio);
  currentRatioRef.current = currentRatio;
  const [isDragging, setIsDragging] = useState(false);

  // Sync local state when the store ratio changes (e.g., layout restore)
  if (!isDragging && ratio !== currentRatio) {
    setCurrentRatio(ratio);
  }

  const isHorizontal = direction === "horizontal";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      useDragOverlayStore.getState().incrementDragCount();

      const container = containerRef.current;
      if (!container) return;

      const onMouseMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        let newRatio: number;
        if (isHorizontal) {
          newRatio = (ev.clientX - rect.left) / rect.width;
        } else {
          newRatio = (ev.clientY - rect.top) / rect.height;
        }
        newRatio = Math.max(0.1, Math.min(0.9, newRatio));
        setCurrentRatio(newRatio);
      };

      const cleanup = () => {
        useDragOverlayStore.getState().decrementDragCount();
        setIsDragging(false);

        const panelId = firstLeafPanelId(first);
        useAppStore.getState().updatePanelSplitRatio(panelId, currentRatioRef.current);

        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [isHorizontal, first],
  );

  const firstSize = `${currentRatio * 100}%`;
  const secondSize = `${(1 - currentRatio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`${styles.split} ${isHorizontal ? styles.splitHorizontal : styles.splitVertical}`}
    >
      <div
        className={styles.splitChild}
        style={isHorizontal ? { width: firstSize } : { height: firstSize }}
      >
        <PanelLayout node={first} workspacePath={workspacePath} onNewTask={onNewTask} />
      </div>
      <div
        className={`${styles.divider} ${isHorizontal ? styles.dividerHorizontal : styles.dividerVertical} ${isDragging ? styles.dividerActive : ""}`}
        onMouseDown={handleMouseDown}
      />
      <div
        className={styles.splitChild}
        style={isHorizontal ? { width: secondSize } : { height: secondSize }}
      >
        <PanelLayout node={second} workspacePath={workspacePath} onNewTask={onNewTask} />
      </div>
    </div>
  );
}
