import { describe, it, expect, beforeEach } from "vitest";
import type { StatsSummary } from "../../../electron.d";
import { useStatsStore } from "../../../store/stats-store";
import {
  diffUnlocks,
  useUnlockQueue,
  watchBadgeUnlocks,
} from "../useBadgeUnlocks";

function summary(badges: Record<string, string> = {}): StatsSummary {
  return {
    today: {},
    last7Days: {},
    allTime: {},
    streakWeeks: 0,
    dailyPrompts: [],
    dailyPrsMerged: [],
    badges,
    enabled: true,
  };
}

const AT = "2026-01-01T00:00:00.000Z";
const TENURE_COMPLETE = {
  "week-streak": AT,
  "month-streak": AT,
  regular: AT,
  devoted: AT,
  "half-year": AT,
  "year-round": AT,
};

describe("diffUnlocks", () => {
  it("returns nothing when nothing changed", () => {
    expect(
      diffUnlocks(
        summary({ "first-blood": AT }),
        summary({ "first-blood": AT }),
      ),
    ).toEqual([]);
  });

  it("lists new badges in order", () => {
    const items = diffUnlocks(
      summary(),
      summary({ "first-blood": AT, executioner: AT }),
    );
    expect(items).toEqual([
      { kind: "badge", id: "first-blood" },
      { kind: "badge", id: "executioner" },
    ]);
  });

  it("detects a track completing after the badge toasts", () => {
    const items = diffUnlocks(
      summary({
        "week-streak": AT,
        "month-streak": AT,
        regular: AT,
        "half-year": AT,
        "year-round": AT,
      }),
      summary(TENURE_COMPLETE),
    );
    expect(items).toEqual([
      { kind: "badge", id: "devoted" },
      { kind: "complete", section: "tenure" },
    ]);
  });
});

describe("watchBadgeUnlocks", () => {
  beforeEach(() => {
    useUnlockQueue.getState().clear();
    useStatsStore.setState({ summary: null });
  });

  it("treats the first summary as a baseline", () => {
    const stop = watchBadgeUnlocks();
    useStatsStore.setState({ summary: summary({ "first-blood": AT }) });
    expect(useUnlockQueue.getState().queue).toEqual([]);
    stop();
  });

  it("queues several unlocks in order and does not replay them", () => {
    useStatsStore.setState({ summary: summary({ "week-streak": AT }) });
    const stop = watchBadgeUnlocks();
    useStatsStore.setState({ summary: summary(TENURE_COMPLETE) });
    expect(useUnlockQueue.getState().queue).toEqual([
      { kind: "badge", id: "month-streak" },
      { kind: "badge", id: "regular" },
      { kind: "badge", id: "devoted" },
      { kind: "badge", id: "half-year" },
      { kind: "badge", id: "year-round" },
      { kind: "complete", section: "tenure" },
    ]);
    useStatsStore.setState({ summary: summary(TENURE_COMPLETE) });
    expect(useUnlockQueue.getState().queue).toHaveLength(6);
    useUnlockQueue.getState().dismiss();
    expect(useUnlockQueue.getState().queue[0]).toEqual({
      kind: "badge",
      id: "regular",
    });
    stop();
  });
});
