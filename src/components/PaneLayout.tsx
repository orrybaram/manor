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
  const paneTitle = useAppStore((s) => s.paneTitle[paneId]);
  const paneCwd = useAppStore((s) => s.paneCwd[paneId]);
  const focusPane = useAppStore((s) => s.focusPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const isFocused = focusedPaneId === paneId;

  const title = paneTitle || (paneCwd ? paneCwd.split("/").pop() : "") || "Terminal";

  const handleSplit = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    splitPane("horizontal");
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusPane(paneId);
    closePane();
  };

  return (
    <div
      className={`${styles.leaf} ${isFocused ? styles.leafFocused : ""}`}
      onMouseDown={() => focusPane(paneId)}
    >
      <div className={`${styles.paneStatusBar} ${isFocused ? styles.paneStatusBarFocused : ""}`}>
          <span className={styles.paneStatusTitle}>{title}</span>
          <div className={styles.paneStatusActions}>
            <button
              className={styles.paneStatusBtn}
              onClick={handleSplit}
              title="Split pane"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="1" width="14" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <line x1="8" y1="1.5" x2="8" y2="14.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className={styles.paneStatusBtn}
              onClick={handleClose}
              title="Close pane"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <line x1="3" y1="3" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" />
                <line x1="13" y1="3" x2="3" y2="13" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </div>
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
