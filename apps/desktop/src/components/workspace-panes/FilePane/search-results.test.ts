import { describe, expect, it } from "vitest";
import type { FileSearchFile } from "../../../electron.d";
import {
  highlightSegments,
  matchCount,
  resultSummary,
  searchRows,
  stepSearchRow,
} from "./search-results";

const files: FileSearchFile[] = [
  {
    path: "src/lib/a.ts",
    matches: [
      { line: 3, col: 5, text: "foo foo", ranges: [[0, 3], [4, 7]] },
      { line: 9, col: 1, text: "foo()", ranges: [[0, 3]] },
    ],
  },
  { path: "README.md", matches: [{ line: 1, col: 1, text: "no ranges", ranges: [] }] },
];

describe("searchRows", () => {
  it("lists each file's header, then its matches, with name, dir and count", () => {
    const rows = searchRows(files, new Set());
    expect(rows.map((r) => r.kind)).toEqual(["file", "match", "match", "file", "match"]);
    expect(rows[0]).toMatchObject({ name: "a.ts", dir: "src/lib", count: 3, collapsed: false });
    expect(rows[3]).toMatchObject({ name: "README.md", dir: "", count: 1 });
  });

  it("leaves out a collapsed file's matches but keeps its header", () => {
    const rows = searchRows(files, new Set(["src/lib/a.ts"]));
    expect(rows.map((r) => r.kind)).toEqual(["file", "file", "match"]);
    expect(rows[0]).toMatchObject({ collapsed: true, count: 3 });
  });

  it("gives every row a distinct key", () => {
    const rows = searchRows(files, new Set());
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe("matchCount", () => {
  it("counts ranges, and a line with none as one", () => {
    expect(matchCount(files[0])).toBe(3);
    expect(matchCount(files[1])).toBe(1);
  });
});

describe("resultSummary", () => {
  it("reads in plural and singular", () => {
    expect(resultSummary(6, 4)).toBe("6 results in 4 files");
    expect(resultSummary(1, 1)).toBe("1 result in 1 file");
    expect(resultSummary(0, 0)).toBe("No results");
  });
});

describe("highlightSegments", () => {
  it("cuts the text at its ranges", () => {
    expect(highlightSegments("a foo b foo", [[2, 5], [8, 11]])).toEqual([
      { text: "a ", match: false },
      { text: "foo", match: true },
      { text: " b ", match: false },
      { text: "foo", match: true },
    ]);
  });

  it("sorts, clamps and merges overlapping ranges", () => {
    expect(highlightSegments("abcdef", [[3, 99], [1, 4], [0, 0]])).toEqual([
      { text: "a", match: false },
      { text: "bcd", match: true },
      { text: "ef", match: true },
    ]);
  });

  it("is the whole text when nothing matches", () => {
    expect(highlightSegments("plain", [])).toEqual([{ text: "plain", match: false }]);
  });
});

describe("stepSearchRow", () => {
  const rows = searchRows(files, new Set());
  it("goes from the input to the first match", () => {
    expect(stepSearchRow(rows, null, 1)).toBe(1);
  });
  it("moves through headers and matches, and stops at the end", () => {
    expect(stepSearchRow(rows, rows[1].key, 1)).toBe(2);
    expect(stepSearchRow(rows, rows[2].key, 1)).toBe(3);
    expect(stepSearchRow(rows, rows[4].key, 1)).toBe(4);
  });
  it("goes back to the input above the first row", () => {
    expect(stepSearchRow(rows, rows[0].key, -1)).toBe(-1);
    expect(stepSearchRow(rows, rows[1].key, -1)).toBe(0);
  });
  it("has nowhere to go with no rows", () => {
    expect(stepSearchRow([], null, 1)).toBe(-1);
  });
});
