import { describe, expect, it } from "vitest";
import {
  dotAlpha,
  dotLooks,
  fillOrder,
  floorGridWidth,
  floorHeight,
  floorLabel,
  FLOOR_BOTTOM,
  FLOOR_TOP,
  gridPoint,
  P,
  socketPosition,
} from "./floor-layout";

describe("floorHeight", () => {
  it("holds every row with room above and below", () => {
    expect(floorHeight(12)).toBe(FLOOR_TOP + FLOOR_BOTTOM + 11 * P);
    expect(floorHeight(1)).toBe(FLOOR_TOP + FLOOR_BOTTOM);
  });
});

describe("floorGridWidth", () => {
  it("always keeps a scrollbar's room, so columns don't follow overflow", () => {
    expect(floorGridWidth(220)).toBe(208);
    expect(floorGridWidth(5)).toBe(0);
  });
});

describe("socketPosition", () => {
  const layout = { cols: 17, rows: 12, width: 236, height: floorHeight(12) };

  it("puts socket 0 bottom-left, centred, with rows counting up", () => {
    const left = (236 - 16 * P) / 2;
    expect(socketPosition(layout, 0)).toEqual([left, layout.height - FLOOR_BOTTOM]);
    expect(socketPosition(layout, 16)).toEqual([left + 16 * P, layout.height - FLOOR_BOTTOM]);
    expect(socketPosition(layout, 17)).toEqual([left, layout.height - FLOOR_BOTTOM - P]);
  });

  it("matches grid points, row 0 at the top", () => {
    expect(gridPoint(layout, 0, 11)).toEqual(socketPosition(layout, 0));
    expect(gridPoint(layout, 3, 0)).toEqual(socketPosition(layout, 17 * 11 + 3));
  });

  it("keeps the top row inside the canvas", () => {
    const [, top] = socketPosition(layout, 17 * 12 - 1);
    expect(top).toBe(FLOOR_TOP);
  });

  it("sits the floor at the bottom of a taller canvas", () => {
    const tall = { ...layout, height: 400 };
    expect(socketPosition(tall, 0)[1]).toBe(400 - FLOOR_BOTTOM);
  });
});

describe("fillOrder", () => {
  it("is a permutation of every socket", () => {
    const order = fillOrder(42, 204);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 204 }, (_, k) => k));
  });

  it("is scattered, and the same for the same seed", () => {
    expect(fillOrder(42, 204)).toEqual(fillOrder(42, 204));
    expect(fillOrder(42, 204)).not.toEqual(fillOrder(43, 204));
    expect(fillOrder(42, 204).slice(0, 10)).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("copes with a zero seed", () => {
    expect(new Set(fillOrder(0, 50)).size).toBe(50);
  });
});

describe("dotLooks", () => {
  const looks = dotLooks(9, 400);

  it("varies size and brightness, with some dim and some flickering", () => {
    expect(new Set(looks.map((l) => l.weight)).size).toBeGreaterThan(20);
    expect(looks.every((l) => l.weight >= 0.15 && l.weight <= 1)).toBe(true);
    expect(looks.some((l) => l.dim)).toBe(true);
    expect(looks.some((l) => l.flicker)).toBe(true);
    expect(looks.every((l) => l.passes >= 1 && l.passes <= 3)).toBe(true);
  });

  it("is stable per seed", () => {
    expect(dotLooks(9, 400)).toEqual(looks);
  });
});

describe("dotAlpha", () => {
  const plain = { weight: 1, dim: false, flicker: false, flick: 0, passes: 2 };

  it("brightens with weight and dims faint dots", () => {
    expect(dotAlpha(plain, 0)).toBeCloseTo(0.9);
    expect(dotAlpha({ ...plain, dim: true }, 0)).toBeCloseTo(0.9 * 0.45);
  });

  it("dims a dot that has passes used up", () => {
    expect(dotAlpha(plain, 0, 1)).toBeCloseTo(0.9 * (0.55 + 0.45 / 2));
  });
});

describe("floorLabel", () => {
  it("states the floor", () => {
    expect(floorLabel(120, 204, "filling")).toBe("House floor: 120 of 204, filling");
    expect(floorLabel(204, 204, "awake")).toBe("House floor: 204 of 204, awake, sweep to feed");
    expect(floorLabel(204, 204, "settle")).toBe("House floor: fed, the house answers");
  });
});
