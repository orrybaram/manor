import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DayBucket, StatCounter, StatsSummary } from "../../electron.d";

let onChangedCallback: ((summary: StatsSummary) => void) | null = null;

const statsApi = {
  getSummary: vi.fn().mockResolvedValue(null as StatsSummary | null),
  reset: vi.fn().mockResolvedValue(undefined),
  onChanged: vi.fn((cb: (summary: StatsSummary) => void) => {
    onChangedCallback = cb;
    return () => {};
  }),
};

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  stats: statsApi,
};

const { useStatsStore, formatUnblockLatency, humanCounterLabel } = await import(
  "../stats-store"
);

function makeSummary(over: Partial<StatsSummary> = {}): StatsSummary {
  return {
    today: {},
    last7Days: {},
    allTime: {},
    streakDays: 0,
    dailyPrompts: [],
    badges: {},
    enabled: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useStatsStore.setState({ summary: null, loaded: false });
});

describe("useStatsStore", () => {
  it("replaces the summary and marks loaded on a changed broadcast", () => {
    const summary = makeSummary({ streakDays: 3 });

    onChangedCallback?.(summary);

    expect(useStatsStore.getState().summary).toEqual(summary);
    expect(useStatsStore.getState().loaded).toBe(true);
  });

  it("proxies reset straight to IPC", async () => {
    await useStatsStore.getState().reset();

    expect(statsApi.reset).toHaveBeenCalled();
  });
});

describe("formatUnblockLatency", () => {
  it("returns null when there are no unblocks", () => {
    expect(formatUnblockLatency({} as DayBucket)).toBeNull();
    expect(
      formatUnblockLatency({ unblocks: 0, unblockMsTotal: 5000 } as DayBucket),
    ).toBeNull();
  });

  it("humanises sub-minute averages as seconds", () => {
    expect(
      formatUnblockLatency({ unblocks: 1, unblockMsTotal: 4000 } as DayBucket),
    ).toBe("4s");
  });

  it("humanises minute-plus averages as minutes and seconds", () => {
    expect(
      formatUnblockLatency({ unblocks: 1, unblockMsTotal: 72_000 } as DayBucket),
    ).toBe("1m 12s");
  });

  it("rounds to the nearest second", () => {
    expect(
      formatUnblockLatency({ unblocks: 2, unblockMsTotal: 7_400 } as DayBucket),
    ).toBe("4s");
  });
});

describe("humanCounterLabel", () => {
  const STAT_COUNTERS: readonly StatCounter[] = [
    "prompts",
    "toolCalls",
    "agentSessions",
    "subagents",
    "agentsResponded",
    "agentsKilled",
    "blocks",
    "unblocks",
    "unblockMsTotal",
    "fastUnblocks",
    "worktreesCreated",
    "worktreesRemoved",
    "worktreesMerged",
    "prApproved",
    "prChangesRequested",
    "prChecksFailed",
  ];

  it.each(STAT_COUNTERS)("returns a non-empty label for %s", (counter) => {
    expect(humanCounterLabel(counter)).toEqual(expect.any(String));
    expect(humanCounterLabel(counter).length).toBeGreaterThan(0);
  });
});
