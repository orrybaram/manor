import { describe, it, expect } from "vitest";
import { settleWithConcurrency } from "./concurrency";

describe("settleWithConcurrency", () => {
  it("runs at most `limit` at once and settles each in order", async () => {
    let running = 0;
    let peak = 0;
    const results = await settleWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (n === 3) throw new Error("three");
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : "rejected"))).toEqual([
      10, 20, "rejected", 40, 50,
    ]);
  });

  it("settles an empty list", async () => {
    await expect(settleWithConcurrency([], 3, async () => 1)).resolves.toEqual([]);
  });
});
