import { describe, expect, it } from "vitest";
import { formatAge } from "./format";

describe("formatAge", () => {
  it("picks one unit", () => {
    expect(formatAge(40_000)).toBe("40s");
    expect(formatAge(12 * 60_000 + 5_000)).toBe("12m");
    expect(formatAge(3 * 3_600_000 + 60_000)).toBe("3h");
    expect(formatAge(2 * 86_400_000 + 3_600_000)).toBe("2d");
  });

  it("clamps negative durations to zero", () => {
    expect(formatAge(-5_000)).toBe("0s");
  });
});
