import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_HIDDEN_COLUMNS,
  MAX_COLUMN_WIDTH,
  clampColumnWidth,
  gridTemplate,
  parseColumnWidths,
  parseHiddenColumns,
  visibleColumns,
} from "./task-columns";

describe("visibleColumns", () => {
  it("gives Priority to Linear only", () => {
    expect(visibleColumns("github", [])).toEqual([
      "id",
      "assignee",
      "status",
      "updated",
    ]);
    expect(visibleColumns("linear", [])).toContain("priority");
  });

  it("drops hidden columns", () => {
    expect(visibleColumns("linear", ["assignee", "priority"])).toEqual([
      "id",
      "status",
      "updated",
    ]);
  });
});

describe("gridTemplate", () => {
  it("puts Title after ID and flexes it", () => {
    expect(
      gridTemplate(["id", "status", "updated"], DEFAULT_COLUMN_WIDTHS),
    ).toBe("64px 80px minmax(120px, 1fr) 88px 104px");
  });

  it("starts with Title when ID is hidden", () => {
    expect(gridTemplate(["updated"], DEFAULT_COLUMN_WIDTHS)).toBe(
      "64px minmax(120px, 1fr) 104px",
    );
  });
});

describe("clampColumnWidth", () => {
  it("holds a width between the column's minimum and the maximum", () => {
    expect(clampColumnWidth("status", 2)).toBe(48);
    expect(clampColumnWidth("status", 10_000)).toBe(MAX_COLUMN_WIDTH);
    expect(clampColumnWidth("status", 99.6)).toBe(100);
  });
});

describe("parseColumnWidths", () => {
  it("falls back to the defaults", () => {
    expect(parseColumnWidths(null)).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(parseColumnWidths("not json")).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(parseColumnWidths("null")).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it("keeps saved widths, clamped, and ignores unknown or bad values", () => {
    expect(
      parseColumnWidths(
        JSON.stringify({ id: 140, status: 1, updated: "wide", title: 300 }),
      ),
    ).toEqual({ ...DEFAULT_COLUMN_WIDTHS, id: 140, status: 48 });
  });
});

describe("parseHiddenColumns", () => {
  it("falls back to the defaults", () => {
    expect(parseHiddenColumns(null)).toEqual(DEFAULT_HIDDEN_COLUMNS);
    expect(parseHiddenColumns("{")).toEqual(DEFAULT_HIDDEN_COLUMNS);
  });

  it("keeps known columns per mode and defaults a missing mode", () => {
    expect(
      parseHiddenColumns(
        JSON.stringify({ table: ["updated", "title", "updated", 3] }),
      ),
    ).toEqual({ table: ["updated"], drawer: DEFAULT_HIDDEN_COLUMNS.drawer });
  });

  it("keeps an empty set: every column shown", () => {
    expect(parseHiddenColumns(JSON.stringify({ drawer: [] })).drawer).toEqual(
      [],
    );
  });
});
