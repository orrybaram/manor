import { describe, it, expect } from "vitest";
import {
  rankCommandIds,
  recordUsage,
  type CommandUsageMap,
} from "../command-usage-store";

describe("recordUsage", () => {
  it("starts a new command at count 1", () => {
    const next = recordUsage({}, "new-tab", 100);
    expect(next["new-tab"]).toEqual({ count: 1, lastUsed: 100 });
  });

  it("increments an existing command and refreshes lastUsed", () => {
    const usage: CommandUsageMap = { "new-tab": { count: 2, lastUsed: 50 } };
    const next = recordUsage(usage, "new-tab", 200);
    expect(next["new-tab"]).toEqual({ count: 3, lastUsed: 200 });
    // Input is not mutated.
    expect(usage["new-tab"]).toEqual({ count: 2, lastUsed: 50 });
  });

  it("evicts the longest-unused entries past the tracking cap", () => {
    let usage: CommandUsageMap = {};
    for (let i = 0; i < 100; i++) {
      usage = recordUsage(usage, `cmd-${i}`, i);
      usage = recordUsage(usage, `cmd-${i}`, i);
    }
    // Every entry has count 2; cmd-0 was used longest ago so it is evicted.
    usage = recordUsage(usage, "fresh", 1000);
    expect(Object.keys(usage)).toHaveLength(100);
    expect(usage["fresh"]).toBeDefined();
    expect(usage["cmd-0"]).toBeUndefined();
    expect(usage["cmd-99"]).toBeDefined();
  });
});

describe("rankCommandIds", () => {
  it("orders by count descending, then by most recent use", () => {
    const usage: CommandUsageMap = {
      rare: { count: 1, lastUsed: 900 },
      "often-old": { count: 5, lastUsed: 100 },
      "often-new": { count: 5, lastUsed: 500 },
      mid: { count: 3, lastUsed: 1 },
    };
    expect(rankCommandIds(usage)).toEqual([
      "often-new",
      "often-old",
      "mid",
      "rare",
    ]);
  });

  it("returns an empty list for no usage", () => {
    expect(rankCommandIds({})).toEqual([]);
  });
});
