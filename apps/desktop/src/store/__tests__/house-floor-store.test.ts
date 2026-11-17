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

beforeEach(() => {
  storage.clear();
  useHouseFloorStore.setState({ floor: null, grid: floorGrid(236) });
});

describe("house floor store", () => {
  it("starts the floor at the current points and persists it", () => {
    useHouseFloorStore.getState().sync(500, 1400);
    const floor = useHouseFloorStore.getState().floor;
    expect(floor).toMatchObject({ baseline: 500, pointsPerFloor: 200, meals: 0 });
    expect(JSON.parse(storage.get(HOUSE_FLOOR_KEY) ?? "null")).toEqual(floor);
  });

  it("survives a restart with the same fill", () => {
    useHouseFloorStore.getState().sync(500, 1400);
    const before = useHouseFloorStore.getState().floor!;
    // A restart: the store's initial state comes from storage.
    const loaded = loadHouseFloor();
    expect(loaded).toEqual(before);
    expect(floorDots(loaded!, 600, 204)).toBe(floorDots(before, 600, 204));
    // Later stats don't move a floor that's filling.
    useHouseFloorStore.getState().sync(650, 9999);
    expect(useHouseFloorStore.getState().floor).toBe(before);
  });

  it("eats only a full floor", () => {
    useHouseFloorStore.getState().sync(0, 1400);
    useHouseFloorStore.getState().eat(150, 1400);
    expect(useHouseFloorStore.getState().floor?.meals).toBe(0);

    useHouseFloorStore.getState().eat(230, 1400);
    const floor = useHouseFloorStore.getState().floor!;
    expect(floor).toMatchObject({ baseline: 200, meals: 1 });
    expect(floorDots(floor, 230, 204)).toBe(30);
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
