import type { DraftComment } from "../../../store/review-store";

export type AnchoredComments = {
  /** `endIndex` -> the comments rendered in that row, in creation order. */
  byEnd: Map<number, DraftComment[]>;
  /** Every index a comment spans, for the "there is a note here" accent. */
  spanned: Set<number>;
};

/**
 * Resolves draft comments to the rows they render in.
 *
 * A comment renders at the *last* line it covers, the way GitHub hangs a
 * review comment under the end of the selected range. Anchors are plain
 * indices into a file's `lines`, and the ADR accepts that they drift when the
 * diff changes underneath a review, so anything pointing past the end of the
 * file is dropped here: a card must never be rendered against a row that does
 * not exist. The draft itself survives in the store and is still submitted —
 * it carries its own snippet.
 */
export function anchorComments(
  comments: DraftComment[],
  lineCount: number,
): AnchoredComments {
  const byEnd = new Map<number, DraftComment[]>();
  const spanned = new Set<number>();

  for (const comment of comments) {
    const end = comment.endIndex;
    if (!Number.isInteger(end) || end < 0 || end >= lineCount) continue;

    const existing = byEnd.get(end);
    if (existing) existing.push(comment);
    else byEnd.set(end, [comment]);

    const start = Math.max(0, Math.min(comment.startIndex, end));
    for (let i = start; i <= end; i++) spanned.add(i);
  }

  return { byEnd, spanned };
}
