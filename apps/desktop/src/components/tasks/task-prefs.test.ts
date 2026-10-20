import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_FILTERS, ME_VALUE } from "../../lib/tasks";
import { isDefaultFilters } from "./task-prefs";

describe("isDefaultFilters", () => {
  it("is true for the defaults", () => {
    expect(isDefaultFilters(DEFAULT_TASK_FILTERS)).toBe(true);
  });

  it("ignores field and value order, and empty lists", () => {
    expect(
      isDefaultFilters({
        label: [],
        progress: ["not-started"],
        assignee: [ME_VALUE],
      }),
    ).toBe(true);
    expect(
      isDefaultFilters({
        ...DEFAULT_TASK_FILTERS,
        assignee: [ME_VALUE, ME_VALUE],
      }),
    ).toBe(true);
  });

  it("is false when a field or value differs", () => {
    expect(isDefaultFilters({})).toBe(false);
    expect(isDefaultFilters({ assignee: [ME_VALUE] })).toBe(false);
    expect(isDefaultFilters({ ...DEFAULT_TASK_FILTERS, label: ["bug"] })).toBe(
      false,
    );
    expect(
      isDefaultFilters({
        ...DEFAULT_TASK_FILTERS,
        progress: ["not-started", "in-progress"],
      }),
    ).toBe(false);
  });
});
