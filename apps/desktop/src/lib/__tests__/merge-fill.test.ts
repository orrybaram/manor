import { describe, expect, it } from "vitest";
import { mergeFillAt } from "../merge-fill";

describe("mergeFillAt", () => {
  it("starts empty and is quick at first", () => {
    expect(mergeFillAt(0)).toBe(0);
    expect(mergeFillAt(450)).toBe(0.5);
    expect(mergeFillAt(-100)).toBe(0);
  });

  it("keeps moving through a long wait and never arrives", () => {
    const waits = [1_600, 5_000, 30_000, 120_000, 3_600_000];
    const fills = waits.map(mergeFillAt);
    for (let i = 1; i < fills.length; i++) expect(fills[i]).toBeGreaterThan(fills[i - 1]);
    expect(fills[fills.length - 1]).toBeLessThan(1);
    // Past where the old fill stopped dead at 92%.
    expect(mergeFillAt(30_000)).toBeGreaterThan(0.92);
  });
});
