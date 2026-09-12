import { describe, it, expect } from "vitest";
import { anchorComments } from "../anchor-comments";
import type { DraftComment } from "../../../../store/review-store";

function draft(partial: Partial<DraftComment> & { id: string }): DraftComment {
  return {
    filePath: "src/app.ts",
    startIndex: 0,
    endIndex: 0,
    snippet: "",
    startLabel: "L1",
    body: "note",
    createdAt: 0,
    ...partial,
  };
}

describe("anchorComments", () => {
  it("renders a comment in the last row it covers", () => {
    const { byEnd } = anchorComments(
      [draft({ id: "a", startIndex: 2, endIndex: 5 })],
      10,
    );

    expect([...byEnd.keys()]).toEqual([5]);
    expect(byEnd.get(5)?.map((c) => c.id)).toEqual(["a"]);
  });

  it("marks every row in a comment's span", () => {
    const { spanned } = anchorComments(
      [draft({ id: "a", startIndex: 2, endIndex: 4 })],
      10,
    );

    expect([...spanned].sort((x, y) => x - y)).toEqual([2, 3, 4]);
  });

  it("keeps several comments on one row in creation order", () => {
    const { byEnd } = anchorComments(
      [
        draft({ id: "first", endIndex: 3 }),
        draft({ id: "second", endIndex: 3 }),
      ],
      10,
    );

    expect(byEnd.get(3)?.map((c) => c.id)).toEqual(["first", "second"]);
  });

  // Anchors are indices into a diff that can change underneath a review; a
  // card must never be rendered against a row that does not exist.
  it("drops a comment anchored past the end of the file", () => {
    const { byEnd, spanned } = anchorComments(
      [
        draft({ id: "gone", startIndex: 9, endIndex: 12 }),
        draft({ id: "here", startIndex: 1, endIndex: 1 }),
      ],
      10,
    );

    expect([...byEnd.keys()]).toEqual([1]);
    expect(spanned.has(9)).toBe(false);
  });

  it("clamps a start index that drifted past its end", () => {
    const { spanned } = anchorComments(
      [draft({ id: "a", startIndex: 8, endIndex: 3 })],
      10,
    );

    expect([...spanned]).toEqual([3]);
  });

  it("is empty for a file with no drafts", () => {
    const { byEnd, spanned } = anchorComments([], 10);

    expect(byEnd.size).toBe(0);
    expect(spanned.size).toBe(0);
  });
});
