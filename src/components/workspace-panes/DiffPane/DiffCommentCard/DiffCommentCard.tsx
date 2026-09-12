import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { DraftComment } from "../../../../store/review-store";
import { Button } from "../../../ui/Button/Button";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import styles from "./DiffCommentCard.module.css";

type DiffCommentCardProps = {
  comment: DraftComment;
  editing: boolean;
  /** Briefly outlined, to catch the eye after the jump list scrolls here. */
  flash?: boolean;
  onSave: (body: string) => void;
  /** Discards an empty new draft; reverts an edit. Owned by the caller. */
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * One draft review comment, rendered inside the diff row it is anchored to.
 *
 * Two states in one component because they are the same card: a composer
 * while you are writing, and a quiet annotation once you are done — a
 * finished review should read as annotated code, not as a column of open
 * text boxes.
 *
 * The card lives inside a virtualized row, so its height is not free: the
 * row's `measureElement` re-reports on every growth. That is why the
 * textarea auto-grows in place (one measure per keystroke that changes the
 * wrap) and then caps and scrolls rather than growing without bound.
 */
export function DiffCommentCard(props: DiffCommentCardProps) {
  const { comment, editing, flash, onSave, onCancel, onEdit, onDelete } = props;

  return editing ? (
    <CommentComposer comment={comment} onSave={onSave} onCancel={onCancel} />
  ) : (
    // `data-comment-id` is how the review bar's jump list finds this card in
    // the document — the only handle on a card that may be anywhere in a very
    // long diff.
    <div
      className={`${styles.card}${flash ? ` ${styles.flash}` : ""}`}
      data-comment-id={comment.id}
    >
      <div className={styles.header}>
        <span className={styles.anchor}>{comment.startLabel}</span>
        <span className={styles.actions}>
          <Tooltip label="Edit comment" side="top">
            <Button
              variant="ghost"
              size="sm"
              className={styles.action}
              aria-label="Edit comment"
              onClick={onEdit}
            >
              <Pencil size={12} />
            </Button>
          </Tooltip>
          <Tooltip label="Delete comment" side="top">
            <Button
              variant="ghost"
              size="sm"
              className={styles.action}
              aria-label="Delete comment"
              onClick={onDelete}
            >
              <Trash2 size={12} />
            </Button>
          </Tooltip>
        </span>
      </div>
      {comment.body.trim() ? (
        <div className={styles.body}>{comment.body}</div>
      ) : (
        <div className={styles.empty}>No comment text.</div>
      )}
    </div>
  );
}

/**
 * The editing half. Split out so the draft body is component state that is
 * born with the composer and dies with it — re-entering edit always starts
 * from what is in the store, and cancelling never has to undo anything.
 */
function CommentComposer(props: {
  comment: DraftComment;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const { comment, onSave, onCancel } = props;
  const [body, setBody] = useState(comment.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** `auto` first: without it the box can only ever grow, never shrink. */
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    autoGrow();
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoGrow]);

  const canSave = body.trim().length > 0;
  const save = () => {
    if (canSave) onSave(body.trim());
  };

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.anchor}>{comment.startLabel}</span>
      </div>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={body}
        placeholder="Leave a comment…"
        spellCheck
        onChange={(e) => {
          setBody(e.target.value);
          autoGrow();
        }}
        // Both keys are claimed by something outside the card — ⌘F opens the
        // diff's search from a window listener, Escape closes overlays — so
        // the card has to swallow them, not just handle them.
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            save();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className={styles.footer}>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!canSave} onClick={save}>
          Add comment
        </Button>
      </div>
    </div>
  );
}
