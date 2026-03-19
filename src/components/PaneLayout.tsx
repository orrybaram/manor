import { useCallback, useRef, useState } from "react";
import type { PaneNode } from "../store/pane-tree";
import { TerminalPane } from "./TerminalPane";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import styles from "./PaneLayout.module.css";

interface PaneLayoutProps {
  node: PaneNode;
  workspacePath?: string;
}

export function PaneLayout({ node, workspacePath }: PaneLayoutProps) {
  if (node.type === "leaf") {
    return <LeafPane paneId={node.paneId} workspacePath={workspacePath} />;
  }

  return (
    <SplitLayout
      direction={node.direction}
      ratio={node.ratio}
      first={node.first}
      second={node.second}
      workspacePath={workspacePath}
    />
  );
}

function LeafPane({ paneId, workspacePath }: { paneId: string; workspacePath?: string }) {
  const focusedPaneId = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === ws.selectedSessionId);
    return session?.focusedPaneId;
  });
  const focusPane = useAppStore((s) => s.focusPane);
  const isFocused = focusedPaneId === paneId;

  return (
    <div
      className={`${styles.leaf} ${isFocused ? styles.leafFocused : ""}`}
      onMouseDown={() => focusPane(paneId)}
    >
      <TerminalPane paneId={paneId} cwd={workspacePath} />
    </div>
  );
}

interface SplitLayoutProps {
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
  workspacePath?: string;
}

function SplitLayout({ direction, ratio, first, second, workspacePath }: SplitLayoutProps) {
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
