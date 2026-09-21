import { useCallback, useRef, useState } from "react";
import type { PaneNode } from "../../lib/layout/pane-tree";
import { paneTreeContains } from "../../lib/layout/pane-tree";
import { findPanelWithPane } from "../../lib/layout/workspace-layout";
import { TAB_HIDDEN_STYLE, TAB_VISIBLE_STYLE } from "../../lib/tab-styles";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { selectFocusedPaneId, useAppStore } from "../../store/app-store";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { PaneLayout } from "./PaneLayout/PaneLayout";
import styles from "./PaneLayout/PaneLayout.module.css";

/** Phone mode: the split is the positioning box its stacked children fill. */
const PHONE_SPLIT_STYLE: React.CSSProperties = { position: "relative" };
/** Phone mode: the divider stays in the tree (so the second child keeps its
 *  position) but takes no space and catches no drag. */
const PHONE_DIVIDER_STYLE: React.CSSProperties = { display: "none" };

function firstLeafPaneId(node: PaneNode): string {
  if (node.type === "leaf") return node.paneId;
  return firstLeafPaneId(node.first);
}

type SplitLayoutProps = {
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
  workspacePath?: string;
};

export function SplitLayout(props: SplitLayoutProps) {
  const { direction, ratio, first, second, workspacePath } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [currentRatio, setCurrentRatio] = useState(ratio);
  const [isDragging, setIsDragging] = useState(false);

  const isPhone = useLayoutMode() === "phone";

  // ADR-181 D1: in phone mode only the child containing the tab's focused
  // pane is shown. A boolean, and only computed in phone mode, so the desk
  // layout never re-renders on a focus change it did not before.
  const focusInSecond = useAppStore((s) => {
    if (!isPhone) return false;
    const path = workspacePath ?? s.activeWorkspacePath;
    const layout = path ? s.workspaceLayouts[path] : undefined;
    if (!layout) return false;
    const found = findPanelWithPane(layout, firstLeafPaneId(first));
    if (!found) return false;
    return paneTreeContains(second, selectFocusedPaneId(s, found.tab.id, path));
  });

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
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [isHorizontal],
  );

  const firstSize = `${currentRatio * 100}%`;
  const secondSize = `${(1 - currentRatio) * 100}%`;

  // Both modes render the same elements, in the same order, with the same
  // types — only `style` and handlers differ. React keeps a component only
  // while its type and position hold, and a remounted terminal is a
  // pty.detach + pty.create, a snapshot restore and possibly a SIGWINCH
  // (ADR-163/164/165). See ADR-181 D1.
  const firstStyle = isPhone
    ? focusInSecond
      ? TAB_HIDDEN_STYLE
      : TAB_VISIBLE_STYLE
    : isHorizontal
      ? { width: firstSize }
      : { height: firstSize };
  const secondStyle = isPhone
    ? focusInSecond
      ? TAB_VISIBLE_STYLE
      : TAB_HIDDEN_STYLE
    : isHorizontal
      ? { width: secondSize }
      : { height: secondSize };

  return (
    <div
      ref={containerRef}
      className={`${styles.split} ${isHorizontal ? styles.splitHorizontal : styles.splitVertical}`}
      style={isPhone ? PHONE_SPLIT_STYLE : undefined}
    >
      <div className={styles.splitChild} style={firstStyle}>
        <PaneLayout node={first} workspacePath={workspacePath} />
      </div>
      <div
        className={`${styles.divider} ${isHorizontal ? styles.dividerHorizontal : styles.dividerVertical} ${isDragging ? styles.dividerActive : ""}`}
        style={isPhone ? PHONE_DIVIDER_STYLE : undefined}
        onMouseDown={isPhone ? undefined : handleMouseDown}
      />
      <div className={styles.splitChild} style={secondStyle}>
        <PaneLayout node={second} workspacePath={workspacePath} />
      </div>
    </div>
  );
}
