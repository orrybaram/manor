import { describe, expect, it } from "vitest";
import { BLANK, buildReels, celebrationTier, type Reel } from "./slot-reels";

/** The digit each reel shows once it has landed. */
const landed = (reels: Reel[]) => reels.map((r) => r.cells[-r.to]).join("");

describe("celebrationTier", () => {
  it("ticks small changes, spins medium ones, jackpots big gains", () => {
    expect(celebrationTier(5053, 5070)).toBe(1);
    expect(celebrationTier(5053, 5300)).toBe(2);
    expect(celebrationTier(5053, 6200)).toBe(3);
  });

  it("never jackpots a shrinking count", () => {
    expect(celebrationTier(5053, 3100)).toBe(2);
    expect(celebrationTier(5053, 5040)).toBe(1);
  });
});

describe("buildReels", () => {
  it.each([
    [5053, 5070, 1],
    [5053, 5300, 2],
    [5053, 6874, 3],
    [999, 1004, 1],
    [5053, 3133, 2],
    [8034, 1269, 2],
    [1200, 840, 2],
  ] as const)("lands %i → %i (tier %i) on the target", (from, to, tier) => {
    const { reels } = buildReels(from, to, tier);
    expect(landed(reels).split(BLANK).join("")).toBe(String(to));
  });

  it("only ever shows digits, even when a reel turns backwards several times", () => {
    // The demo bug: (a - s + 10) % 10 goes negative after one full turn.
    const { reels } = buildReels(9999, 1000, 3);
    for (const r of reels) {
      for (const c of r.cells) expect(c === BLANK || /^[0-9]$/.test(c)).toBe(true);
    }
  });

  it("holds unchanged digits still below the jackpot", () => {
    const { reels } = buildReels(5053, 5070, 1);
    expect(reels.slice(0, 2).map((r) => r.durationMs)).toEqual([0, 0]);
  });

  it("spins every digit on a jackpot, landing left to right", () => {
    const { reels, totalMs } = buildReels(5053, 6874, 3);
    const durations = reels.map((r) => r.durationMs);
    expect(durations.every((d) => d > 0)).toBe(true);
    expect([...durations].sort((x, y) => x - y)).toEqual(durations);
    expect(totalMs).toBe(durations[durations.length - 1]);
  });

  it("grows a blank reel in when the number gains a digit", () => {
    const { reels } = buildReels(999, 1004, 1);
    expect(reels[0].cells[0]).toBe(BLANK);
    expect(landed(reels)).toBe("1004");
  });
});
