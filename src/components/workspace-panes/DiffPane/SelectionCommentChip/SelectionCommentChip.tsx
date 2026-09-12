import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import { Button } from "../../../ui/Button/Button";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import { selectionToAnchor, type SelectionAnchor } from "../review-anchor";
import styles from "./SelectionCommentChip.module.css";

type SelectionCommentChipProps = {
  /** The DiffPane scroll container — selections outside it are ignored. */
  containerRef: RefObject<HTMLDivElement | null>;
  onComment: (anchor: SelectionAnchor) => void;
};

/** Gap between the selection's edge and the chip. */
const GAP = 6;
/** Keep the chip this far from every viewport edge. */
const MARGIN = 8;
/** Below this much room under the selection, the chip flips above it. */
const ROOM_BELOW = 44;

type ChipTarget = {
  anchor: SelectionAnchor;
  /** Viewport coords of the selection, snapshotted at evaluation time. */
  rect: { top: number; bottom: number; left: number };
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The entry point into a review: select lines in a diff and a "Comment" chip
 * appears beside them.
 *
 * It reads the selection off the document rather than owning any of the diff's
 * markup, which is what lets a selection spanning several hunks work with no
 * per-row affordance. `selectionToAnchor` is the arbiter of whether a given
 * selection is commentable, so the chip and the copy handler always agree on
 * which lines a selection covers.
 */
export function SelectionCommentChip(props: SelectionCommentChipProps) {
  const { containerRef, onComment } = props;
  const [target, setTarget] = useState<ChipTarget | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);

  /**
   * Positioned after mount rather than from a style prop because placement
   * needs the chip's own size: both the flip-above case and the viewport
   * clamp. A layout effect runs before paint, so this never shows at 0,0.
   */
  useLayoutEffect(() => {
    const el = chipRef.current;
    if (!el || !target) return;
    const { width, height } = el.getBoundingClientRect();
    const { rect } = target;
    const below = window.innerHeight - rect.bottom >= ROOM_BELOW;
    const top = below ? rect.bottom + GAP : rect.top - height - GAP;
    el.style.left = `${clamp(rect.left, MARGIN, window.innerWidth - width - MARGIN)}px`;
    el.style.top = `${clamp(top, MARGIN, window.innerHeight - height - MARGIN)}px`;
  }, [target]);

  useEffect(() => {
    let frame = 0;

    const evaluate = () => {
      frame = 0;
      const container = containerRef.current;
      const sel = window.getSelection();
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        setTarget(null);
        return;
      }
      // `selectionchange` is a document-level event and several DiffPanes can
      // be on screen at once, so each chip only claims selections rooted in
      // its own pane.
      if (!sel.anchorNode || !container.contains(sel.anchorNode)) {
        setTarget(null);
        return;
      }
      const anchor = selectionToAnchor(sel);
      if (!anchor) {
        setTarget(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setTarget({
        anchor,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left },
      });
    };

    /** `selectionchange` fires on every mouse move of a drag; one evaluation
     *  per frame is enough, and keeps the row walk off the drag's hot path. */
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(evaluate);
    };

    const hide = () => setTarget(null);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("selectionchange", schedule);
    // A drag that ends without moving the caret fires no `selectionchange`,
    // so the release itself has to be a trigger. Listened for on the document,
    // not the container: a drag started in the diff often ends outside it.
    document.addEventListener("mouseup", schedule);
    document.addEventListener("keyup", schedule);
    // Capture, because scroll does not bubble and the diff scrolls in a
    // container nested well below the pane.
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("mouseup", schedule);
      document.removeEventListener("keyup", schedule);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [containerRef]);

  const handleClick = useCallback(() => {
    if (!target) return;
    onComment(target.anchor);
    setTarget(null);
  }, [target, onComment]);

  if (!target) return null;

  const { startLabel } = target.anchor;
  const label = startLabel ? `Comment on ${startLabel}` : "Comment on selection";

  return createPortal(
    <div
      ref={chipRef}
      className={styles.chip}
      // Without this the mousedown collapses the selection, and by the time
      // the click lands there is nothing left to anchor a comment to.
      onMouseDown={(e) => e.preventDefault()}
    >
      <Tooltip label={label} side="top">
        <Button
          variant="secondary"
          size="sm"
          className={styles.button}
          onClick={handleClick}
        >
          <MessageSquarePlus size={12} />
          Comment
        </Button>
      </Tooltip>
    </div>,
    document.body,
  );
}
