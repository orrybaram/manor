import { describe, it, expect } from "vitest";
import {
  buildContributionGrid,
  levelFor,
  monthLabels,
} from "../contribution-grid";

/** Wednesday, 2026-09-02 — mid-week, so future-day trimming is exercised. */
const TODAY = new Date(2026, 8, 2);

describe("levelFor", () => {
  it("gives zero counts level 0", () => {
    expect(levelFor(0, 10)).toBe(0);
  });

  it("gives any recorded day at least level 1", () => {
    expect(levelFor(1, 1000)).toBe(1);
  });

  it("scales against the busiest day", () => {
    expect(levelFor(2, 8)).toBe(1);
    expect(levelFor(4, 8)).toBe(2);
    expect(levelFor(6, 8)).toBe(3);
    expect(levelFor(8, 8)).toBe(4);
  });

  it("stays at 0 when nothing was recorded at all", () => {
    expect(levelFor(0, 0)).toBe(0);
  });
});

describe("buildContributionGrid", () => {
  it("builds the requested number of seven-day columns", () => {
    const grid = buildContributionGrid([], TODAY, 53);
    expect(grid.weeks).toHaveLength(53);
    for (const week of grid.weeks) expect(week).toHaveLength(7);
  });

  it("puts today in the last column and nulls the days after it", () => {
    const grid = buildContributionGrid([], TODAY, 4);
    const last = grid.weeks[grid.weeks.length - 1];
    // Wednesday is index 3 with Sunday-first columns.
    expect(last[3]?.day).toBe("2026-09-02");
    expect(last[4]).toBeNull();
    expect(last[5]).toBeNull();
    expect(last[6]).toBeNull();
  });

  it("maps counts onto their day and leaves the rest at zero", () => {
    const grid = buildContributionGrid(
      [{ day: "2026-09-01", count: 12 }],
      TODAY,
      4,
    );
    const cells = grid.weeks.flat().filter((cell) => cell !== null);
    const busiest = cells.find((cell) => cell.day === "2026-09-01");
    expect(busiest?.count).toBe(12);
    expect(busiest?.level).toBe(4);
    expect(cells.filter((cell) => cell.count > 0)).toHaveLength(1);
  });

  it("ignores days outside the rendered range", () => {
    const grid = buildContributionGrid(
      [
        { day: "2020-01-01", count: 99 },
        { day: "2026-09-01", count: 3 },
      ],
      TODAY,
      4,
    );
    expect(grid.total).toBe(3);
    expect(grid.max).toBe(3);
    expect(grid.activeDays).toBe(1);
  });

  it("does not count future days toward the totals", () => {
    const grid = buildContributionGrid(
      [{ day: "2026-09-05", count: 50 }],
      TODAY,
      4,
    );
    expect(grid.total).toBe(0);
    expect(grid.activeDays).toBe(0);
  });

  it("reports totals across the range", () => {
    const grid = buildContributionGrid(
      [
        { day: "2026-09-01", count: 4 },
        { day: "2026-09-02", count: 6 },
      ],
      TODAY,
      4,
    );
    expect(grid.total).toBe(10);
    expect(grid.max).toBe(6);
    expect(grid.activeDays).toBe(2);
  });
});

describe("monthLabels", () => {
  it("labels a month once per run, in column order", () => {
    const { weeks } = buildContributionGrid([], TODAY, 53);
    const labels = monthLabels(weeks);
    // A 53-week range can revisit a month name a year later, so only adjacent
    // repeats are wrong.
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i].label).not.toBe(labels[i - 1].label);
      expect(labels[i].weekIndex).toBeGreaterThan(labels[i - 1].weekIndex);
    }
    expect(labels.map((l) => l.label)).toContain("Sep");
  });

  it("drops a leading label that would collide with the next one", () => {
    // A 53-week range ending 2026-09-05 opens on Sun 2025-08-31: a lone August
    // column immediately followed by September.
    const { weeks } = buildContributionGrid([], TODAY, 53);
    expect(weeks[0][0]?.day).toBe("2025-08-31");
    expect(monthLabels(weeks)[0].label).toBe("Sep");
  });

  it("keeps a leading label with room before the next month", () => {
    const { weeks } = buildContributionGrid([], TODAY, 2);
    const labels = monthLabels(weeks);
    expect(labels).toHaveLength(1);
    expect(labels[0].label).toBe("Aug");
  });
});
