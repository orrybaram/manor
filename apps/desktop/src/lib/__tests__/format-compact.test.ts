import { describe, expect, it } from "vitest";
import { formatCompact } from "../format-compact";

describe("formatCompact", () => {
  it.each([
    [0, "0"],
    [7, "7"],
    [950, "950"],
    [999, "999"],
    [1_000, "1k"],
    [1_049, "1k"],
    [12_400, "12.4k"],
    [123_456, "123k"],
    [999_499, "999k"],
    [999_500, "1M"],
    [999_950, "1M"],
    [22_700_000, "22.7M"],
    [1_234_000_000, "1.2B"],
    [3_400_000_000_000, "3.4T"],
    [-12_400, "-12.4k"],
  ])("%d → %s", (n, out) => {
    expect(formatCompact(n)).toBe(out);
  });

  it("never prints NaN", () => {
    expect(formatCompact(Number.NaN)).toBe("0");
  });
});
