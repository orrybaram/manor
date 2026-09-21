import { useCallback, useRef, useState } from "react";
import type { PanelNode } from "../../lib/layout/panel-tree";
import { panelTreeContains } from "../../lib/layout/panel-tree";
import type { SplitDirection } from "../../lib/layout/pane-tree";
import { TAB_HIDDEN_STYLE, TAB_VISIBLE_STYLE } from "../../lib/tab-styles";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { activePanelIdOf, useAppStore } from "../../store/app-store";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import { PanelLayout } from "./PanelLayout";
import styles from "../workspace-panes/PaneLayout/PaneLayout.module.css";

/** Phone mode: the split is the positioning box its stacked children fill. */
const PHONE_SPLIT_STYLE: React.CSSProperties = { position: "relative" };
/** Phone mode: the divider stays in the tree (so the second child keeps its
 *  position) but takes no space and catches no drag. */
const PHONE_DIVIDER_STYLE: React.CSSProperties = { display: "none" };

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
  onNewAgent: () => void;
};

export function SplitPanelLayout(props: SplitPanelLayoutProps) {
  const { direction, ratio, first, second, workspacePath, onNewAgent } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [currentRatio, setCurrentRatio] = useState(ratio);
  const currentRatioRef = useRef(currentRatio);
  currentRatioRef.current = currentRatio;
  const [isDragging, setIsDragging] = useState(false);

  // Sync local state when the store ratio changes (e.g., layout restore)
  if (!isDragging && ratio !== currentRatio) {
    setCurrentRatio(ratio);
  }

  const isPhone = useLayoutMode() === "phone";

  // ADR-181 D1: in phone mode only the child containing this workspace's
  // active panel is shown. A boolean, and only computed in phone mode, so the
  // desk layout never re-renders on a focus change it did not before.
  const focusInSecond = useAppStore(
    (s) => isPhone && panelTreeContains(second, activePanelIdOf(s, workspacePath)),
  );

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
        <PanelLayout node={first} workspacePath={workspacePath} onNewAgent={onNewAgent} />
      </div>
      <div
        className={`${styles.divider} ${isHorizontal ? styles.dividerHorizontal : styles.dividerVertical} ${isDragging ? styles.dividerActive : ""}`}
        style={isPhone ? PHONE_DIVIDER_STYLE : undefined}
        onMouseDown={isPhone ? undefined : handleMouseDown}
      />
      <div className={styles.splitChild} style={secondStyle}>
        <PanelLayout node={second} workspacePath={workspacePath} onNewAgent={onNewAgent} />
      </div>
    </div>
  );
}
