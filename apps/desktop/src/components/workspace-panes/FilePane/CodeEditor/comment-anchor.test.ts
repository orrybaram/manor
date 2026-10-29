import { describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { unifiedMergeView } from "@codemirror/merge";
import {
  anchorFor,
  lineLabel,
  mapAnchor,
  selectedLines,
  snippetFor,
  spanOf,
  type Anchor,
} from "./comment-anchor";

const doc = (...lines: string[]) => Text.of(lines);

/** `anchor` after replacing `from`..`to` of `before` with `insert`. */
function edit(before: Text, anchor: Anchor, from: number, to: number, insert: string) {
  const state = EditorState.create({ doc: before });
  const tr = state.update({ changes: { from, to, insert } });
  const after = tr.state.doc;
  return spanOf(after, mapAnchor(anchor, tr.changes, before, after));
}

describe("lineLabel", () => {
  it("names one line or a range, en dash between", () => {
    expect(lineLabel({ startLine: 12, endLine: 12 })).toBe("L12");
    expect(lineLabel({ startLine: 12, endLine: 18 })).toBe("L12–L18");
  });
});

describe("selectedLines", () => {
  const text = doc("one", "two", "three");

  it("takes every line the selection touches", () => {
    expect(selectedLines(text, 1, 6)).toEqual({ startLine: 1, endLine: 2 });
  });

  it("leaves out a line the selection only reaches the start of", () => {
    expect(selectedLines(text, 0, text.line(3).from)).toEqual({ startLine: 1, endLine: 2 });
  });
});

describe("mapAnchor", () => {
  const text = doc("a", "b", "c", "d", "e");
  const onBC = anchorFor(text, { startLine: 2, endLine: 3 });

  it("moves down when a line is inserted above", () => {
    expect(edit(text, onBC, 0, 0, "new\n")).toEqual({ startLine: 3, endLine: 4 });
  });

  it("stays put for an edit below", () => {
    expect(edit(text, onBC, text.line(5).from, text.line(5).from, "x\n")).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  it("grows with a line typed inside it", () => {
    expect(edit(text, onBC, text.line(2).to, text.line(2).to, "\nb2")).toEqual({
      startLine: 2,
      endLine: 4,
    });
  });

  it("keeps a line typed at its first line's start on that line", () => {
    expect(edit(text, onBC, text.line(2).from, text.line(2).from, "x")).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  it("lands on the line that took its place when its lines are deleted", () => {
    expect(edit(text, onBC, text.line(2).from, text.line(4).from, "")).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  it("keeps its line numbers through a wholesale replacement", () => {
    expect(edit(text, onBC, 0, text.length, "1\n2\n3\n4\n5\n6")).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });
});

describe("anchorFor", () => {
  it("clamps lines past the end to the last line", () => {
    const text = doc("a", "b");
    expect(spanOf(text, anchorFor(text, { startLine: 5, endLine: 9 }))).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });
});

describe("snippetFor", () => {
  const original = "one\ntwo\nthree\nfour\n";
  const working = "one\nTWO\nthree\nfour\n";
  const state = EditorState.create({
    doc: working,
    extensions: unifiedMergeView({ original, mergeControls: false }),
  });
  const line = (n: number) => state.doc.line(n);

  it("numbers each working line", () => {
    expect(snippetFor(state, line(3).from, line(4).to)).toBe("3: three\n4: four");
  });

  it("takes in the removed lines shown above a selected line", () => {
    expect(snippetFor(state, line(1).from, line(2).to)).toBe("1: one\n-2: two\n2: TWO");
  });

  it("takes them in when the selection starts in the removed block", () => {
    expect(snippetFor(state, line(2).from, line(2).to)).toBe("-2: two\n2: TWO");
  });

  it("leaves them out when the selection starts past them", () => {
    expect(snippetFor(state, line(2).from + 1, line(2).to)).toBe("2: TWO");
  });
});
