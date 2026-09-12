import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import { Button } from "../../../ui/Button/Button";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import {
  selectionRowRange,
  selectionToAnchor,
  type SelectionAnchor,
  type SelectionRowRange,
} from "../review-anchor";
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
  range: SelectionRowRange;
  /**
   * Viewport coords of the selection, snapshotted at evaluation time. `top`
   * and `bottom` bound the whole selection; `left` is where its text starts
   * (see `selectionBox`), not the bounding box's left edge.
   */
  rect: { top: number; bottom: number; left: number };
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Sub-pixel jitter during a drag is not a move worth re-rendering for. */
function sameTarget(a: ChipTarget | null, b: ChipTarget): boolean {
  return (
    a !== null &&
    a.range.startIndex === b.range.startIndex &&
    a.range.endIndex === b.range.endIndex &&
    Math.abs(a.rect.top - b.rect.top) < 1 &&
    Math.abs(a.rect.bottom - b.rect.bottom) < 1 &&
    Math.abs(a.rect.left - b.rect.left) < 1
  );
}

/**
 * Where to hang the chip: the top and left of where the selection *starts*,
 * and the bottom of where it *ends*.
 *
 * Measured with two collapsed probe ranges rather than the selection's own
 * rects. `getBoundingClientRect` on a multi-row range is the union of every
 * rect it touches, so its left edge is the line-number gutter rather than the
 * code — and `getClientRects` returns one rect per line, which is a growing
 * amount of layout work to redo on every frame of a drag. A collapsed range
 * measures one point.
 */
function selectionBox(range: Range): {
  top: number;
  bottom: number;
  left: number;
} {
  const startProbe = range.cloneRange();
  startProbe.collapse(true);
  const endProbe = range.cloneRange();
  endProbe.collapse(false);

  const start = startProbe.getBoundingClientRect();
  const end = endProbe.getBoundingClientRect();

  // A collapsed range can measure as all-zero where there is no text box to
  // sit in; the union rect is wrong-but-present, which beats the viewport
  // corner.
  if (start.top === 0 && start.bottom === 0 && start.left === 0) {
    const union = range.getBoundingClientRect();
    return { top: union.top, bottom: union.bottom, left: union.left };
  }

  return {
    top: start.top,
    bottom: Math.max(end.bottom, start.bottom),
    left: start.left,
  };
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
      // The cheap probe, not `selectionToAnchor`: this runs once per frame for
      // the whole of a drag, and reading every covered row's text that often
      // is what made selecting in a long diff feel heavy. The full anchor —
      // snippet included — is resolved in `handleClick`, off the live
      // selection, exactly once.
      const rowRange = selectionRowRange(sel);
      if (!rowRange) {
        setTarget(null);
        return;
      }

      const next: ChipTarget = {
        range: rowRange,
        rect: selectionBox(sel.getRangeAt(0)),
      };
      // Re-rendering re-measures the chip and re-runs its layout effect, so a
      // drag that has not actually changed the answer should not cause one.
      setTarget((prev) => (sameTarget(prev, next) ? prev : next));
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
    const sel = window.getSelection();
    const anchor = sel ? selectionToAnchor(sel) : null;
    if (anchor) onComment(anchor);
    setTarget(null);
  }, [onComment]);

  if (!target) return null;

  const { startLabel } = target.range;
  const label = startLabel
    ? `Comment on ${startLabel}`
    : "Comment on selection";

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
