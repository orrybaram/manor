import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatsSummary } from "../../electron.d";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

const { HOUSE_FLOOR_KEY, loadHouseFloor, useHouseFloorStore } = await import(
  "../house-floor-store"
);
const { floorDots, floorGrid, HOUSE_SETTLE_MS } = await import("../../lib/house-floor");
const { useStatsStore } = await import("../stats-store");

function summary(day: string, today: Record<string, number>, last7 = today): StatsSummary {
  return {
    today,
    last7Days: last7,
    allTime: today,
    streakWeeks: 0,
    dailyPrompts: [],
    dailyPrsMerged: [{ day, count: 0 }],
    badges: {},
    enabled: true,
  };
}

const DAY = "2026-11-17";

beforeEach(() => {
  storage.clear();
  useStatsStore.setState({ summary: null });
  useHouseFloorStore.setState({ floor: null, grid: floorGrid(236) });
});

describe("house floor store", () => {
  it("starts the floor empty at today's points and persists it", () => {
    useHouseFloorStore.getState().sync(DAY, 50, 1400);
    const floor = useHouseFloorStore.getState().floor;
    expect(floor).toMatchObject({ day: DAY, todayMax: 50, progress: 0, pointsPerFloor: 200, meals: 0 });
    expect(JSON.parse(storage.get(HOUSE_FLOOR_KEY) ?? "null")).toEqual(floor);
  });

  it("survives a restart with the same fill", () => {
    useHouseFloorStore.getState().sync(DAY, 0, 1400);
    useHouseFloorStore.getState().sync(DAY, 100, 1400);
    const before = useHouseFloorStore.getState().floor!;
    // A restart: the store's initial state comes from storage.
    const loaded = loadHouseFloor();
    expect(loaded).toEqual(before);
    expect(floorDots(loaded!, 204)).toBe(102);
    // The same summary again banks nothing.
    useHouseFloorStore.getState().sync(DAY, 100, 1400);
    expect(useHouseFloorStore.getState().floor).toBe(before);
  });

  it("eats only a full floor", () => {
    useHouseFloorStore.getState().sync(DAY, 0, 1400);
    useHouseFloorStore.getState().sync(DAY, 150, 1400);
    useHouseFloorStore.getState().eat(1400);
    expect(useHouseFloorStore.getState().floor?.meals).toBe(0);

    useHouseFloorStore.getState().sync(DAY, 230, 1400);
    useHouseFloorStore.getState().eat(1400);
    const floor = useHouseFloorStore.getState().floor!;
    expect(floor).toMatchObject({ progress: 30, meals: 1 });
    expect(floorDots(floor, 204)).toBe(30);
    expect(loadHouseFloor()).toEqual(floor);
  });

  it("keeps Settle up from the very update that eats the floor until it's played", () => {
    vi.useFakeTimers();
    try {
      useHouseFloorStore.setState({ settling: false });
      useHouseFloorStore.getState().sync(DAY, 0, 1400);
      useHouseFloorStore.getState().sync(DAY, 200, 1400);
      // Every update anyone sees: an empty floor is never seen without Settle.
      const seen: { dots: number; settling: boolean }[] = [];
      const unsubscribe = useHouseFloorStore.subscribe((state) => {
        seen.push({ dots: floorDots(state.floor!, 204), settling: state.settling });
      });
      useHouseFloorStore.getState().eat(1400);
      expect(seen).toEqual([{ dots: 0, settling: true }]);
      vi.advanceTimersByTime(HOUSE_SETTLE_MS - 1);
      expect(useHouseFloorStore.getState().settling).toBe(true);
      vi.advanceTimersByTime(1);
      expect(useHouseFloorStore.getState().settling).toBe(false);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stored value that isn't a floor", () => {
    storage.set(HOUSE_FLOOR_KEY, "{not json");
    expect(loadHouseFloor()).toBeNull();
    storage.set(HOUSE_FLOOR_KEY, JSON.stringify({ baseline: 1 }));
    expect(loadHouseFloor()).toBeNull();
  });

  it("banks every summary on its own, with no floor on screen", () => {
    // Started when the module loaded: no component, no hook.
    useStatsStore.setState({ summary: summary(DAY, { agentsKilled: 10 }, { agentsKilled: 210 }) });
    expect(useHouseFloorStore.getState().floor).toMatchObject({
      day: DAY,
      todayMax: 20,
      progress: 0,
      pointsPerFloor: 60,
    });
    useStatsStore.setState({ summary: summary(DAY, { agentsKilled: 25 }, { agentsKilled: 225 }) });
    expect(useHouseFloorStore.getState().floor).toMatchObject({ todayMax: 50, progress: 30 });
    // Past midnight, the new day's points all count.
    useStatsStore.setState({ summary: summary("2026-11-18", { agentsKilled: 3 }, { agentsKilled: 228 }) });
    expect(useHouseFloorStore.getState().floor).toMatchObject({
      day: "2026-11-18",
      todayMax: 6,
      progress: 36,
    });
    expect(loadHouseFloor()).toEqual(useHouseFloorStore.getState().floor);
  });

  it("follows the width to whole rows", () => {
    useHouseFloorStore.getState().setWidth(220);
    expect(useHouseFloorStore.getState().grid).toEqual({ cols: 16, rows: 13, size: 208 });
  });
});
