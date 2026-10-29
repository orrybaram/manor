import { describe, expect, it } from "vitest";
import type { DraftComment } from "../../../store/review-store";
import { commentWhere } from "./useReviewSend";

const comment = (over: Partial<DraftComment>): DraftComment => ({
  id: "c",
  filePath: "src/components/DiffPane.tsx",
  snippet: "",
  startLabel: "",
  body: "note",
  createdAt: 0,
  ...over,
});

describe("commentWhere", () => {
  it("names the file and its line", () => {
    expect(commentWhere(comment({ startLine: 414, endLine: 414 }))).toBe("DiffPane.tsx:414");
  });

  it("names a range of lines", () => {
    expect(commentWhere(comment({ startLine: 7, endLine: 8 }))).toBe("DiffPane.tsx:7–8");
  });

  it("falls back to a Diff pane comment's label", () => {
    expect(commentWhere(comment({ startIndex: 3, endIndex: 3, startLabel: "L12" }))).toBe(
      "DiffPane.tsx L12",
    );
  });
});
