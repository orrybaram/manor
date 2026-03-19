import { useCallback, useRef, useState } from "react";
import type { PaneNode } from "../store/pane-tree";
import { PaneLayout } from "./PaneLayout";
import styles from "./PaneLayout.module.css";

interface SplitLayoutProps {
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
  workspacePath?: string;
}

export function SplitLayout({ direction, ratio, first, second, workspacePath }: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentRatio, setCurrentRatio] = useState(ratio);
  const [isDragging, setIsDragging] = useState(false);

  const isHorizontal = direction === "horizontal";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

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

      const onMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [isHorizontal]
  );

  const firstSize = `${currentRatio * 100}%`;
  const secondSize = `${(1 - currentRatio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`${styles.split} ${isHorizontal ? styles.splitHorizontal : styles.splitVertical}`}
    >
      <div className={styles.splitChild} style={isHorizontal ? { width: firstSize } : { height: firstSize }}>
        <PaneLayout node={first} workspacePath={workspacePath} />
      </div>
      <div
        className={`${styles.divider} ${isHorizontal ? styles.dividerHorizontal : styles.dividerVertical} ${isDragging ? styles.dividerActive : ""}`}
        onMouseDown={handleMouseDown}
      />
      <div className={styles.splitChild} style={isHorizontal ? { width: secondSize } : { height: secondSize }}>
        <PaneLayout node={second} workspacePath={workspacePath} />
      </div>
    </div>
  );
}
