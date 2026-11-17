import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

const { HOUSE_FLOOR_KEY, loadHouseFloor, useHouseFloorStore } = await import(
  "../house-floor-store"
);
const { floorDots, floorGrid } = await import("../../lib/house-floor");

const DAY = "2026-11-17";

beforeEach(() => {
  storage.clear();
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

  it("ignores a stored value that isn't a floor", () => {
    storage.set(HOUSE_FLOOR_KEY, "{not json");
    expect(loadHouseFloor()).toBeNull();
    storage.set(HOUSE_FLOOR_KEY, JSON.stringify({ baseline: 1 }));
    expect(loadHouseFloor()).toBeNull();
  });

  it("follows the width to whole rows", () => {
    useHouseFloorStore.getState().setWidth(220);
    expect(useHouseFloorStore.getState().grid).toEqual({ cols: 16, rows: 13, size: 208 });
  });
});
