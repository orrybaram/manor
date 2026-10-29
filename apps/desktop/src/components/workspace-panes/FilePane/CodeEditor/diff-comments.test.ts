import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { useReviewStore } from "../../../../store/review-store";
import { commentPosition, reviewComments } from "./diff-comments";

const WS = "/ws";

afterEach(() => useReviewStore.setState({ drafts: {} }));

function draft(path: string, startLine?: number, endLine?: number) {
  return useReviewStore.getState().addDraft(WS, {
    filePath: path,
    startLine,
    endLine,
    snippet: "",
    startLabel: "",
    body: "note",
  });
}

describe("reviewComments", () => {
  it("places the open file's editor comments on their stored lines", () => {
    const here = draft("a.ts", 2, 3);
    const elsewhere = draft("b.ts", 1, 1);
    const diffPane = draft("a.ts");
    const state = EditorState.create({
      doc: "one\ntwo\nthree\nfour",
      extensions: reviewComments({ workspacePath: WS, path: "a.ts" }),
    });

    expect(commentPosition(state, here)).toBe(state.doc.line(3).to);
    expect(commentPosition(state, elsewhere)).toBeNull();
    expect(commentPosition(state, diffPane)).toBeNull();
  });

  it("follows its lines through an edit above them", () => {
    const id = draft("a.ts", 2, 2);
    const state = EditorState.create({
      doc: "one\ntwo\nthree",
      extensions: reviewComments({ workspacePath: WS, path: "a.ts" }),
    });
    const next = state.update({ changes: { from: 0, insert: "zero\n" } }).state;

    expect(next.doc.lineAt(commentPosition(next, id) ?? -1).number).toBe(3);
  });
});
