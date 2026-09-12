import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { DraftComment } from "../../../../store/review-store";
import { Button } from "../../../ui/Button/Button";
import { Tooltip } from "../../../ui/Tooltip/Tooltip";
import styles from "./DiffCommentCard.module.css";

type DiffCommentCardProps = {
  comment: DraftComment;
  /** Briefly outlined, to catch the eye after the jump list scrolls here. */
  flash?: boolean;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * A saved review comment, rendered inside the diff row it is anchored to — a
 * quiet annotation, so a finished review reads as annotated code rather than
 * a column of open text boxes. Writing one is `CommentComposer` below; the
 * two are separate components because a comment being written does not exist
 * in the store yet and so has no `DraftComment` to render.
 */
export function DiffCommentCard(props: DiffCommentCardProps) {
  const { comment, flash, onEdit, onDelete } = props;

  return (
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
      <div className={styles.body}>{comment.body}</div>
    </div>
  );
}

/**
 * Writing a comment, new or edited.
 *
 * Takes a label and a starting body rather than a `DraftComment`, because a
 * new comment has none: nothing reaches the store until it has been saved,
 * which is what keeps "a draft with no body" from being a state anything
 * downstream has to handle.
 *
 * It lives inside a virtualized row, so its height is not free — the row's
 * `measureElement` re-reports on every growth. Hence the textarea auto-grows
 * in place and then caps and scrolls rather than growing without bound.
 */
export function CommentComposer(props: {
  startLabel: string;
  initialBody?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const { startLabel, initialBody = "", onSave, onCancel } = props;
  const [body, setBody] = useState(initialBody);
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
        <span className={styles.anchor}>{startLabel}</span>
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
