import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  useReviewStore,
  NO_DRAFTS,
  type DraftComment,
} from "../../../store/review-store";
import {
  CommentComposer,
  DiffCommentCard,
} from "./DiffCommentCard/DiffCommentCard";
import { anchorComments } from "./anchor-comments";
import type { SelectionAnchor } from "./review-anchor";
import type { DiffFile } from "./types";

/** Frames `jumpToComment` waits for a virtualized card to mount. */
const JUMP_FRAMES = 20;
/** Within this many px of centred counts as arrived. */
const JUMP_TOLERANCE = 8;
/** Re-centring passes after the first scroll, while the rows settle. */
const JUMP_SETTLE_PASSES = 8;
/** Gap between passes — long enough for one smooth scroll to land. */
const JUMP_SETTLE_MS = 120;
/** Must outlast the card's flash animation, or it cuts off mid-fade. */
const FLASH_MS = 1600;

/**
 * The one comment being written, if any.
 *
 * A comment being *written* is deliberately not in the store: it reaches the
 * store when it is saved, and never before. That is what makes "a draft with
 * an empty body" unrepresentable rather than a state every consumer has to
 * filter out — and it is why cancelling, or starting a second comment, has
 * nothing to clean up.
 */
type Composing =
  | { kind: "new"; filePath: string; anchor: SelectionAnchor }
  | { kind: "edit"; filePath: string; id: string };

/** What a file's `DiffLines` needs in order to show its part of the review. */
export type FileAnnotations = {
  /** Rows a comment covers, for the "there is a note here" accent. */
  markedRows: ReadonlySet<number>;
  /** The cards to hang inside row `index`, or `null`. */
  renderRowExtra: (index: number) => ReactNode;
};

type DraftReviewOptions = {
  workspacePath?: string;
  files: DiffFile[];
  /** The pane's scroll container, searched when jumping to a comment. */
  containerRef: RefObject<HTMLDivElement | null>;
  fileRefs: RefObject<Map<string, HTMLDivElement>>;
  /** Un-collapse a file, so a card in it has somewhere to appear. */
  revealFile: (path: string) => void;
};

export type DraftReview = {
  /** Annotations for one file, or `undefined` when it carries no comments. */
  annotationsFor: (filePath: string) => FileAnnotations | undefined;
  /** Open a composer on a selection. The file comes from the DOM if not given. */
  startComment: (anchor: SelectionAnchor, knownFilePath?: string) => void;
  /** Scroll a saved comment back into view and flash it. */
  jumpToComment: (comment: DraftComment) => void;
};

/**
 * An anchor is only line indices, and those are per-file — so the file a
 * selection sits in has to come from the DOM. The per-file wrapper carries
 * `data-file-path` for exactly this.
 */
function filePathForSelection(): string | null {
  const node = window.getSelection()?.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest<HTMLElement>("[data-file-path]")?.dataset.filePath ?? null;
}

/**
 * Everything the diff pane needs to carry a review: the drafts for this
 * workspace, the one comment being written, and the cards to render inside
 * the diff.
 *
 * It lives outside `DiffPane` because none of it is about showing a diff —
 * the pane supplies its container, its per-file elements and a way to
 * un-collapse a file, and gets back per-file annotations it can hand to
 * `DiffLines` without knowing what is in them.
 */
export function useDraftReview(opts: DraftReviewOptions): DraftReview {
  const { workspacePath, files, containerRef, fileRefs, revealFile } = opts;

  const drafts = useReviewStore((s) =>
    workspacePath ? (s.drafts[workspacePath] ?? NO_DRAFTS) : NO_DRAFTS,
  );
  const [composing, setComposing] = useState<Composing | null>(null);
  const [flashCommentId, setFlashCommentId] = useState<string | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draftsByFile = useMemo(() => {
    const byFile = new Map<string, DraftComment[]>();
    for (const draft of drafts) {
      const existing = byFile.get(draft.filePath);
      if (existing) existing.push(draft);
      else byFile.set(draft.filePath, [draft]);
    }
    return byFile;
  }, [drafts]);

  const startComment = useCallback(
    (anchor: SelectionAnchor, knownFilePath?: string) => {
      if (!workspacePath) return;
      const filePath = knownFilePath ?? filePathForSelection();
      if (!filePath) return;

      setComposing({ kind: "new", filePath, anchor });

      // The selection has done its job; leaving it lit behind the composer
      // reads as though it were still live.
      window.getSelection()?.removeAllRanges();

      // A collapsed file renders no rows, so the composer would have nowhere
      // to appear.
      revealFile(filePath);
    },
    [workspacePath, revealFile],
  );

  const cancelComposing = useCallback(() => setComposing(null), []);

  /**
   * The only write that creates a comment. `CommentComposer` will not call it
   * with a blank body, which is what lets the store's invariant — every draft
   * has something in it — hold without anyone checking downstream.
   */
  const saveComposing = useCallback(
    (body: string) => {
      if (!workspacePath || !composing) return;
      const store = useReviewStore.getState();
      if (composing.kind === "new") {
        store.addDraft(workspacePath, {
          filePath: composing.filePath,
          startIndex: composing.anchor.startIndex,
          endIndex: composing.anchor.endIndex,
          snippet: composing.anchor.snippet,
          startLabel: composing.anchor.startLabel,
          body,
        });
      } else {
        store.updateDraft(workspacePath, composing.id, body);
      }
      setComposing(null);
    },
    [workspacePath, composing],
  );

  const deleteComment = useCallback(
    (id: string) => {
      if (!workspacePath) return;
      useReviewStore.getState().removeDraft(workspacePath, id);
      setComposing((c) => (c?.kind === "edit" && c.id === id ? null : c));
    },
    [workspacePath],
  );

  /**
   * Scroll a comment back into view for the review bar's jump list.
   *
   * The card may not be in the document yet: its file can be collapsed, and
   * the rows are virtualized, so un-collapsing is not enough on its own.
   * Scrolling the *file* into view is what puts the card's row in range, and
   * only then can it be found — hence the bounded retry rather than a single
   * lookup. Falling back to the file header is a worse answer than the card,
   * but a much better one than nothing happening at all.
   *
   * One scroll is also not enough: the rows are measured as they mount, so
   * the content above the card keeps changing height while the smooth scroll
   * is still in flight and it lands short. So the jump re-centres on a timer
   * until the card stops moving, the budget runs out, or the scroll stops
   * making progress (a card near the end of the diff can never be centred).
   */
  const jumpToComment = useCallback(
    (comment: DraftComment) => {
      revealFile(comment.filePath);
      fileRefs.current
        ?.get(comment.filePath)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });

      const findCard = () =>
        containerRef.current?.querySelector(
          `[data-comment-id="${CSS.escape(comment.id)}"]`,
        ) ?? null;

      /** How far the card sits from the middle of the pane, in px. */
      const driftFromCentre = (card: Element): number | null => {
        const container = containerRef.current;
        if (!container) return null;
        const cardBox = card.getBoundingClientRect();
        const viewBox = container.getBoundingClientRect();
        return (
          cardBox.top + cardBox.height / 2 - (viewBox.top + viewBox.height / 2)
        );
      };

      let passes = 0;
      let lastDrift: number | null = null;
      const settle = () => {
        const card = findCard();
        const drift = card ? driftFromCentre(card) : null;
        if (!card || drift === null) return;

        const arrived = Math.abs(drift) <= JUMP_TOLERANCE;
        const stalled =
          lastDrift !== null && Math.abs(drift - lastDrift) < 1 && !arrived;
        if (arrived || stalled) return;

        lastDrift = drift;
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        if (passes++ < JUMP_SETTLE_PASSES)
          jumpTimer.current = setTimeout(settle, JUMP_SETTLE_MS);
      };

      let attempts = 0;
      const reveal = () => {
        const card = findCard();
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          setFlashCommentId(comment.id);
          jumpTimer.current = setTimeout(settle, JUMP_SETTLE_MS);
          return;
        }
        if (attempts++ < JUMP_FRAMES) requestAnimationFrame(reveal);
      };

      if (jumpTimer.current) clearTimeout(jumpTimer.current);
      requestAnimationFrame(reveal);
    },
    [containerRef, fileRefs, revealFile],
  );

  /** A jump still re-centring must not outlive the pane. */
  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    [],
  );

  /** Clear the flash once its animation has played out. */
  useEffect(() => {
    if (!flashCommentId) return;
    const timer = setTimeout(() => setFlashCommentId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashCommentId]);

  const annotations = useMemo(() => {
    const byPath = new Map<string, FileAnnotations>();

    for (const file of files) {
      const fileDrafts = draftsByFile.get(file.path);
      const pending =
        composing?.kind === "new" && composing.filePath === file.path
          ? composing
          : null;
      if (!fileDrafts && !pending) continue;

      const { byEnd, spanned } = anchorComments(
        fileDrafts ?? NO_DRAFTS,
        file.lines.length,
      );

      const marked = new Set(spanned);
      if (pending) {
        const end = Math.min(pending.anchor.endIndex, file.lines.length - 1);
        for (let i = Math.max(0, pending.anchor.startIndex); i <= end; i++) {
          marked.add(i);
        }
      }

      const renderRowExtra = (index: number): ReactNode => {
        const cards: ReactNode[] = [];

        for (const comment of byEnd.get(index) ?? []) {
          cards.push(
            composing?.kind === "edit" && composing.id === comment.id ? (
              <CommentComposer
                key={comment.id}
                startLabel={comment.startLabel}
                initialBody={comment.body}
                onSave={saveComposing}
                onCancel={cancelComposing}
              />
            ) : (
              <DiffCommentCard
                key={comment.id}
                comment={comment}
                flash={flashCommentId === comment.id}
                onEdit={() =>
                  setComposing({
                    kind: "edit",
                    filePath: comment.filePath,
                    id: comment.id,
                  })
                }
                onDelete={() => deleteComment(comment.id)}
              />
            ),
          );
        }

        if (
          pending &&
          clampedEnd(pending.anchor, file.lines.length) === index
        ) {
          cards.push(
            <CommentComposer
              key="composing"
              startLabel={pending.anchor.startLabel}
              onSave={saveComposing}
              onCancel={cancelComposing}
            />,
          );
        }

        return cards.length > 0 ? cards : null;
      };

      byPath.set(file.path, { markedRows: marked, renderRowExtra });
    }

    return byPath;
  }, [
    files,
    draftsByFile,
    composing,
    flashCommentId,
    saveComposing,
    cancelComposing,
    deleteComment,
  ]);

  const annotationsFor = useCallback(
    (filePath: string) => annotations.get(filePath),
    [annotations],
  );

  return { annotationsFor, startComment, jumpToComment };
}

/**
 * Where a pending comment's composer hangs. Clamped because a selection that
 * ran to the end of a file, in a diff that then shrank, would otherwise point
 * at a row that no longer exists and the composer would vanish mid-typing.
 */
function clampedEnd(anchor: SelectionAnchor, lineCount: number): number {
  return Math.max(0, Math.min(anchor.endIndex, lineCount - 1));
}
