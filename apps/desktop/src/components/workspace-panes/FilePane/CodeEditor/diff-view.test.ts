import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { unfoldAt, unifiedDiff } from "./diff-view";

const lines = (n: number, changed?: number) =>
  Array.from({ length: n }, (_, i) => (i + 1 === changed ? `changed ${i + 1}` : `line ${i + 1}`)).join("\n");

describe("unfoldAt", () => {
  // Line 30 changed: lines 1-26 fold (3 lines of margin), 27-33 show.
  const state = EditorState.create({ doc: lines(40, 30), extensions: unifiedDiff(lines(40)) });
  const at = (line: number) => state.doc.line(line).to;

  it("unfolds the folded stretch a position is in", () => {
    const effects = unfoldAt(state, at(10));
    expect(effects).toHaveLength(1);
    expect(effects[0].value).toBe(state.doc.line(1).from);
    const unfolded = state.update({ effects }).state;
    expect(unfoldAt(unfolded, at(10))).toEqual([]);
  });

  it("leaves a shown line alone", () => {
    expect(unfoldAt(state, at(30))).toEqual([]);
  });
});
