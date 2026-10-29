import { useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import type { DraftComment } from "../../../../store/review-store";
import { Collapse } from "../../../ui/Collapse/Collapse";
import {
  DiscardReviewButton,
  SendSplitButton,
} from "../../../review/ReviewSend/ReviewSend";
import { commentWhere, useReviewSend } from "../../../review/ReviewSend/useReviewSend";
import styles from "./SourceControl.module.css";

/**
 * "Review comments (N)", pinned under Source Control's lists in either view:
 * the workspace's draft comments, each a way to its card in its file's diff,
 * then Send and Discard. Comments are the workspace's, as Source Control is,
 * so this is where the review is finished. Only there while there are drafts.
 */
export function ReviewSection({
  workspacePath,
  hostId,
  onJump,
}: {
  workspacePath: string;
  /** The workspace's host: a review sent to a new agent runs there. */
  hostId?: string;
  /** A comment was clicked: show it. */
  onJump: (comment: DraftComment) => void;
}) {
  const review = useReviewSend(workspacePath, hostId);
  const [open, setOpen] = useState(true);
  const count = review.comments.length;
  if (count === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className={styles.review} data-testid="scm-review-section">
      <div className={styles.groupHead}>
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Chevron size={12} className={styles.chevron} />
          <span className={styles.groupLabel}>Review comments</span>
          <span className={styles.groupCount}>{count}</span>
        </button>
      </div>
      <Collapse open={open}>
        <div className={styles.reviewList}>
          {review.comments.map((comment) => (
            <button
              key={comment.id}
              type="button"
              className={styles.reviewItem}
              data-testid="scm-review-item"
              title={comment.body.trim()}
              onClick={() => onJump(comment)}
            >
              <span className={styles.reviewWhere}>{commentWhere(comment)}</span>
              <span className={styles.reviewBody}>{comment.body.trim()}</span>
            </button>
          ))}
        </div>
        <div className={styles.reviewActions}>
          <SendSplitButton review={review} testId="scm-review-send" />
          <DiscardReviewButton
            workspacePath={workspacePath}
            count={count}
            testId="scm-review-discard"
          />
        </div>
      </Collapse>
    </div>
  );
}
