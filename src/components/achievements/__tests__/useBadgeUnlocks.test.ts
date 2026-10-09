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
const SEALED = { "first-blood": AT, executioner: AT, "cold-blooded": AT };

describe("diffUnlocks", () => {
  it("returns nothing when nothing changed", () => {
    expect(diffUnlocks(summary({ "first-blood": AT }), summary({ "first-blood": AT }))).toEqual([]);
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

  it("detects a seal after the badge toasts", () => {
    const items = diffUnlocks(
      summary({ "first-blood": AT, executioner: AT }),
      summary(SEALED),
    );
    expect(items).toEqual([
      { kind: "badge", id: "cold-blooded" },
      { kind: "seal", section: "carnage" },
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
    useStatsStore.setState({ summary: summary({ "first-blood": AT }) });
    const stop = watchBadgeUnlocks();
    useStatsStore.setState({ summary: summary(SEALED) });
    expect(useUnlockQueue.getState().queue).toEqual([
      { kind: "badge", id: "executioner" },
      { kind: "badge", id: "cold-blooded" },
      { kind: "seal", section: "carnage" },
    ]);
    useStatsStore.setState({ summary: summary(SEALED) });
    expect(useUnlockQueue.getState().queue).toHaveLength(3);
    useUnlockQueue.getState().dismiss();
    expect(useUnlockQueue.getState().queue[0]).toEqual({
      kind: "badge",
      id: "cold-blooded",
    });
    stop();
  });
});
