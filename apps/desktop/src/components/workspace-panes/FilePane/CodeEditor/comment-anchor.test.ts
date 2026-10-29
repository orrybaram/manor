import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { unifiedMergeView } from "@codemirror/merge";
import { parseDiff } from "../../../../lib/diff/parser";
import type { DiffLine } from "../../../../lib/diff/types";
import { reviewPrompt } from "../../../../lib/review-submit";
import type { DraftComment } from "../../../../store/review-store";
import {
  anchorFor,
  cardPos,
  changesToMap,
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
  return spanOf(after, mapAnchor(anchor, changesToMap(tr.changes, before, after)));
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

  it("keeps its card under the whole line when text is typed at its last line's end", () => {
    const state = EditorState.create({ doc: text });
    const tr = state.update({ changes: { from: text.line(3).to, insert: " more" } });
    const moved = mapAnchor(onBC, changesToMap(tr.changes, text, tr.state.doc));
    expect(spanOf(tr.state.doc, moved)).toEqual({ startLine: 2, endLine: 3 });
    expect(cardPos(tr.state.doc, moved)).toBe(tr.state.doc.line(3).to);
  });

  it("follows its text through a wholesale replacement (a reload from disk)", () => {
    expect(edit(text, onBC, 0, text.length, "new\na\nb\nc\nd\ne")).toEqual({
      startLine: 3,
      endLine: 4,
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

const dir = mkdtempSync(join(tmpdir(), "comment-anchor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Git's own diff of `before` → `after`, as the Diff pane reads it. */
function gitDiff(before: string, after: string): string {
  writeFileSync(join(dir, "a"), before);
  writeFileSync(join(dir, "b"), after);
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", "a", "b"], { cwd: dir, encoding: "utf8" });
    return "";
  } catch (err) {
    return (err as { stdout: string }).stdout;
  }
}

/** A Diff pane row's text, as `DiffLines`' row source gives it to a selection. */
function diffPaneRow(line: DiffLine): string {
  if (line.type === "hunk") return line.content;
  const num = line.type === "del" ? line.oldNum : line.newNum;
  const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return num !== undefined ? `${num}: ${prefix}${line.content}` : `${prefix}${line.content}`;
}

/**
 * The Diff pane's snippet for working lines `first`..`last`, selected from
 * the removed rows just above `first` (where the editor's selection from
 * `first`'s start takes them in).
 */
function diffPaneSnippet(rows: DiffLine[], first: number, last: number): string {
  let i = rows.findIndex((r) => r.type !== "del" && r.newNum === first);
  while (i > 0 && rows[i - 1].type === "del") i--;
  const j = rows.findIndex((r) => r.type !== "del" && r.newNum === last);
  return rows.slice(i, j + 1).map(diffPaneRow).join("\n");
}

describe("snippetFor", () => {
  const before = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n") + "\n";
  const after = ["one", "TWO", "three", "five", "six", "six and a half", "seven", "eight"].join("\n") + "\n";
  const rows = parseDiff(gitDiff(before, after))[0].lines;
  const state = EditorState.create({
    doc: after,
    extensions: unifiedMergeView({ original: before, mergeControls: false }),
  });
  const line = (n: number) => state.doc.line(n);

  it.each([
    [1, 2],
    [2, 2],
    [3, 4],
    [4, 7],
    [1, 8],
  ])("quotes lines %i–%i as the Diff pane does", (first, last) => {
    expect(snippetFor(state, line(first).from, line(last).to)).toBe(diffPaneSnippet(rows, first, last));
  });

  it("marks each kind of row", () => {
    expect(snippetFor(state, line(1).from, line(2).to)).toBe("1:  one\n2: -two\n2: +TWO");
    expect(snippetFor(state, line(4).from, line(4).to)).toBe("4: -four\n4:  five");
  });

  it("leaves out removed lines when the selection starts past them", () => {
    expect(snippetFor(state, line(2).from + 1, line(2).to)).toBe("2: +TWO");
  });

  it("gives the agent's prompt the lines and code of a comment made on a selection", () => {
    // As the composer saves one: the selected lines' anchor, its span and label, and its snippet.
    const from = line(1).from;
    const to = line(2).to;
    const anchor = anchorFor(state.doc, selectedLines(state.doc, from, to));
    const span = spanOf(state.doc, anchor);
    const draft: DraftComment = {
      id: "c1",
      createdAt: 0,
      filePath: "src/numbers.txt",
      ...span,
      snippet: snippetFor(state, from, to),
      startLabel: lineLabel(span),
      body: "  Why capitals?  ",
    };

    const prompt = reviewPrompt([draft]).split("\n");
    expect(prompt[0]).toMatch(/^I left a comment on the current diff\./);
    expect(prompt.slice(1)).toEqual([
      "[1] src/numbers.txt L1–L2 — Why capitals?",
      "    Code: 1:  one",
      "2: -two",
      "2: +TWO",
    ]);
  });
});
