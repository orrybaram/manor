// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  rowsInSelection,
  selectionRowRange,
  selectionSnippet,
  selectionToAnchor,
} from "../review-anchor";

/**
 * jsdom (as of the version pinned here) does not implement the partial-
 * containment branch of `Selection.containsNode` per spec — it reports a
 * node as "contained" based on which side of the range it falls on rather
 * than whether it actually overlaps, so unrelated siblings anywhere in the
 * document come back `true`. `Range.comparePoint` *is* spec-correct, so this
 * suite rebuilds `containsNode` on top of it. This only patches the jsdom
 * environment this file runs in — `rowsInSelection` itself still calls the
 * real `sel.containsNode(row, true)`, unchanged, and that call is correct in
 * every real browser/Electron, which is what ships.
 */
beforeAll(() => {
  Selection.prototype.containsNode = function (
    node: Node,
    allowPartialContainment?: boolean,
  ): boolean {
    if (this.rangeCount === 0) return false;
    const range = this.getRangeAt(0);
    const len = node.childNodes.length;
    const startCmp = range.comparePoint(node, 0);
    const endCmp = range.comparePoint(node, len);
    return allowPartialContainment
      ? endCmp !== -1 && startCmp !== 1
      : startCmp === 0 && endCmp === 0;
  };
});

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

interface RowSpec {
  index: number;
  /** Rendered line number; empty for a hunk header row. */
  num?: string;
  content: string;
}

/** Builds a `[data-diff-lines]` container shaped like `DiffLines`' row markup. */
function buildDiffLines(rows: RowSpec[]): HTMLElement {
  const container = document.createElement("div");
  container.setAttribute("data-diff-lines", "");
  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.setAttribute("data-index", String(row.index));
    const numCell = document.createElement("div");
    numCell.textContent = row.num ?? "";
    const contentCell = document.createElement("div");
    contentCell.textContent = row.content;
    rowEl.append(numCell, contentCell);
    container.appendChild(rowEl);
  }
  document.body.appendChild(container);
  return container;
}

/** Selects from one row's content text to another's, by character offset. */
function selectRows(
  container: HTMLElement,
  start: { index: number; offset: number },
  end: { index: number; offset: number },
): Selection {
  const startRow = container.querySelector(`[data-index="${start.index}"]`)!;
  const endRow = container.querySelector(`[data-index="${end.index}"]`)!;
  const startText = startRow.children[1].firstChild!;
  const endText = endRow.children[1].firstChild!;

  const range = document.createRange();
  range.setStart(startText, start.offset);
  range.setEnd(endText, end.offset);

  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe("rowsInSelection / selectionSnippet / selectionToAnchor", () => {
  it("resolves a single-line selection", () => {
    const container = buildDiffLines([
      { index: 0, num: "10", content: "const a = 1;" },
      { index: 1, num: "11", content: "const b = 2;" },
    ]);
    const sel = selectRows(
      container,
      { index: 0, offset: 0 },
      { index: 0, offset: 5 },
    );

    const rows = rowsInSelection(sel);
    expect(rows.map((r) => r.dataset.index)).toEqual(["0"]);

    expect(selectionSnippet(sel)).toBe("10: const a = 1;");

    expect(selectionToAnchor(sel)).toEqual({
      startIndex: 0,
      endIndex: 0,
      snippet: "10: const a = 1;",
      startLabel: "L10",
    });
  });

  it("resolves a multi-line range", () => {
    const container = buildDiffLines([
      { index: 0, num: "10", content: "const a = 1;" },
      { index: 1, num: "11", content: "const b = 2;" },
      { index: 2, num: "12", content: "const c = 3;" },
    ]);
    const sel = selectRows(
      container,
      { index: 0, offset: 2 },
      { index: 2, offset: 4 },
    );

    const rows = rowsInSelection(sel);
    expect(rows.map((r) => r.dataset.index)).toEqual(["0", "1", "2"]);

    expect(selectionSnippet(sel)).toBe(
      "10: const a = 1;\n11: const b = 2;\n12: const c = 3;",
    );

    expect(selectionToAnchor(sel)).toEqual({
      startIndex: 0,
      endIndex: 2,
      snippet: "10: const a = 1;\n11: const b = 2;\n12: const c = 3;",
      startLabel: "L10–L12",
    });
  });

  it("resolves a range that includes a hunk header", () => {
    const container = buildDiffLines([
      { index: 0, num: "5", content: "const a = 1;" },
      { index: 1, content: "@@ -5,3 +5,4 @@" },
      { index: 2, num: "6", content: "const b = 2;" },
    ]);
    const sel = selectRows(
      container,
      { index: 0, offset: 0 },
      { index: 2, offset: 3 },
    );

    const rows = rowsInSelection(sel);
    expect(rows.map((r) => r.dataset.index)).toEqual(["0", "1", "2"]);

    expect(selectionSnippet(sel)).toBe(
      "5: const a = 1;\n@@ -5,3 +5,4 @@\n6: const b = 2;",
    );

    expect(selectionToAnchor(sel)).toEqual({
      startIndex: 0,
      endIndex: 2,
      snippet: "5: const a = 1;\n@@ -5,3 +5,4 @@\n6: const b = 2;",
      startLabel: "L5–L6",
    });
  });

  it("falls back to an empty label when neither end has a line number", () => {
    const container = buildDiffLines([
      { index: 0, content: "@@ -1,3 +1,4 @@" },
    ]);
    const sel = selectRows(
      container,
      { index: 0, offset: 0 },
      { index: 0, offset: 5 },
    );

    expect(selectionToAnchor(sel)?.startLabel).toBe("");
  });

  it("returns null / empty for a collapsed selection", () => {
    buildDiffLines([{ index: 0, num: "1", content: "const a = 1;" }]);
    const sel = window.getSelection()!;
    sel.removeAllRanges();

    expect(sel.isCollapsed).toBe(true);
    expect(rowsInSelection(sel)).toEqual([]);
    expect(selectionSnippet(sel)).toBeNull();
    expect(selectionToAnchor(sel)).toBeNull();
  });

  it("clamps a selection spanning two files to the file it started in", () => {
    // Two `[data-diff-lines]` containers, the way two files in the Stack look
    // in the DOM: `rowsInSelection` must resolve from `sel.anchorNode` (the
    // file the selection *started* in) rather than falling back to whichever
    // container is first in document order.
    const fileA = buildDiffLines([
      { index: 0, num: "10", content: "const a = 1;" },
      { index: 1, num: "11", content: "const b = 2;" },
    ]);
    const fileB = buildDiffLines([
      { index: 0, num: "1", content: "const x = 9;" },
      { index: 1, num: "2", content: "const y = 8;" },
    ]);

    const startRow = fileA.querySelector('[data-index="1"]')!;
    const endRow = fileB.querySelector('[data-index="0"]')!;
    const startText = startRow.children[1].firstChild!;
    const endText = endRow.children[1].firstChild!;

    const range = document.createRange();
    range.setStart(startText, 0);
    range.setEnd(endText, 5);

    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const rows = rowsInSelection(sel);
    expect(rows.every((r) => fileA.contains(r))).toBe(true);
    expect(rows.some((r) => fileB.contains(r))).toBe(false);
    expect(rows.map((r) => r.dataset.index)).toEqual(["1"]);

    expect(selectionSnippet(sel)).toBe("11: const b = 2;");

    expect(selectionToAnchor(sel)).toEqual({
      startIndex: 1,
      endIndex: 1,
      snippet: "11: const b = 2;",
      startLabel: "L11",
    });
  });
});

describe("selectionRowRange", () => {
  it("resolves the same rows as selectionToAnchor, without the snippet", () => {
    const container = buildDiffLines([
      { index: 0, num: "10", content: "const a = 1;" },
      { index: 1, num: "11", content: "const b = 2;" },
      { index: 2, num: "12", content: "const c = 3;" },
    ]);
    const sel = selectRows(
      container,
      { index: 0, offset: 0 },
      { index: 2, offset: 5 },
    );

    expect(selectionRowRange(sel)).toEqual({
      startIndex: 0,
      endIndex: 2,
      startLabel: "L10–L12",
    });
  });

  it("is null for a collapsed selection", () => {
    const container = buildDiffLines([
      { index: 0, num: "10", content: "const a = 1;" },
    ]);
    const sel = selectRows(
      container,
      { index: 0, offset: 2 },
      { index: 0, offset: 2 },
    );

    expect(selectionRowRange(sel)).toBeNull();
  });

  /**
   * The chip runs this once per frame for the whole of a drag. It used to
   * test every row in the file with `containsNode`, which made selecting in a
   * long diff feel heavy — so the cost must not scale with the file.
   */
  it("does not scale with the number of rows in the file", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      index: i,
      num: String(i + 1),
      content: `const v${i} = ${i};`,
    }));
    const container = buildDiffLines(rows);

    const real = Selection.prototype.containsNode;
    let calls = 0;
    Selection.prototype.containsNode = function (...args) {
      calls++;
      return real.apply(this, args);
    };

    try {
      const sel = selectRows(
        container,
        { index: 5, offset: 0 },
        { index: 390, offset: 3 },
      );
      const range = selectionRowRange(sel);

      expect(range?.startIndex).toBe(5);
      expect(range?.endIndex).toBe(390);
      // Two endpoints, and at most one inward step each.
      expect(calls).toBeLessThanOrEqual(4);
    } finally {
      Selection.prototype.containsNode = real;
    }
  });
});
