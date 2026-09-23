import { useCallback, useRef, useState, type ReactNode } from "react";
import type { SplitDirection } from "../../lib/layout/pane-tree";
import { TAB_HIDDEN_STYLE, TAB_VISIBLE_STYLE } from "../../lib/tab-styles";
import { useLayoutMode } from "../../hooks/useLayoutMode";
import { useDragOverlayStore } from "../../store/drag-overlay-store";
import styles from "./PaneLayout/PaneLayout.module.css";

/** Phone mode: the split is the positioning box its stacked children fill. */
const PHONE_SPLIT_STYLE: React.CSSProperties = { position: "relative" };
/** Phone mode: the divider stays in the tree (so the second child keeps its
 *  position) but takes no space and catches no drag. */
const PHONE_DIVIDER_STYLE: React.CSSProperties = { display: "none" };

type SplitFrameProps = {
  direction: SplitDirection;
  /** The tree's ratio. A drag moves a local copy, which follows this again
   *  whenever the tree's value changes. */
  ratio: number;
  /** Phone mode only: whether `second` holds what the phone shows. Callers
   *  compute it only in phone mode, so the desk never re-renders on focus. */
  focusInSecond: boolean;
  /** Fires once, on release, with the ratio the divider was dragged to. */
  onCommitRatio?: (ratio: number) => void;
  first: ReactNode;
  second: ReactNode;
};

/**
 * The one split box both `SplitLayout` (panes) and `SplitPanelLayout`
 * (panels) render: two children and a draggable divider on the desk, two
 * stacked `tab-styles` layers with only one shown on a phone (ADR-181 D1).
 */
export function SplitFrame(props: SplitFrameProps) {
  const { direction, ratio, focusInSecond, onCommitRatio, first, second } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [currentRatio, setCurrentRatio] = useState(ratio);
  const currentRatioRef = useRef(currentRatio);
  currentRatioRef.current = currentRatio;
  const [isDragging, setIsDragging] = useState(false);

  // Follow the tree when its ratio changes (e.g. a layout restore or another
  // window's drag), but never mid-drag.
  const [treeRatio, setTreeRatio] = useState(ratio);
  if (ratio !== treeRatio) {
    setTreeRatio(ratio);
    if (!isDragging) setCurrentRatio(ratio);
  }

  const onCommitRatioRef = useRef(onCommitRatio);
  onCommitRatioRef.current = onCommitRatio;

  const isPhone = useLayoutMode() === "phone";
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
        onCommitRatioRef.current?.(currentRatioRef.current);
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
        {first}
      </div>
      <div
        className={`${styles.divider} ${isHorizontal ? styles.dividerHorizontal : styles.dividerVertical} ${isDragging ? styles.dividerActive : ""}`}
        style={isPhone ? PHONE_DIVIDER_STYLE : undefined}
        onMouseDown={isPhone ? undefined : handleMouseDown}
      />
      <div className={styles.splitChild} style={secondStyle}>
        {second}
      </div>
    </div>
  );
}
