import { describe, expect, it } from "vitest";
import {
  bucketPoints,
  consumeMeal,
  floorDots,
  floorGrid,
  floorScale,
  isFloorAwake,
  MIN_AVERAGE_DAY_POINTS,
  parseFloorState,
  pointsPerFloor,
  reconcileFloor,
  startFloor,
} from "../house-floor";

describe("bucketPoints", () => {
  it("weights the counters that end things", () => {
    expect(
      bucketPoints({
        agentsKilled: 1, // 2
        agentsKilledMidThought: 1, // 3
        subagents: 3, // 1.5
        worktreesRemoved: 1, // 3
        prsMerged: 1, // 2
        prChecksFailed: 1, // 1
        tokens: 250_000, // 2.5
      }),
    ).toBeCloseTo(15);
  });

  it("ignores other counters and missing ones", () => {
    expect(bucketPoints({ prompts: 500, toolCalls: 90 })).toBe(0);
    expect(bucketPoints({})).toBe(0);
  });

  it("scores the mock's busy day at about 200", () => {
    const busy = {
      agentsKilled: 20,
      agentsKilledMidThought: 2,
      subagents: 150,
      worktreesRemoved: 20,
      prsMerged: 17,
      prChecksFailed: 3,
      tokens: 22_700_000,
    };
    expect(bucketPoints(busy)).toBeCloseTo(40 + 6 + 75 + 60 + 34 + 3 + 227);
  });
});

describe("floorGrid", () => {
  it("is whole rows of about 200 sockets", () => {
    expect(floorGrid(236)).toEqual({ cols: 17, rows: 12, size: 204 });
    expect(floorGrid(220)).toEqual({ cols: 16, rows: 13, size: 208 });
  });

  it("keeps a minimum grid when very narrow", () => {
    const grid = floorGrid(10);
    expect(grid.cols).toBe(4);
    expect(grid.rows).toBe(50);
    expect(floorGrid(Number.NaN).cols).toBe(4);
  });
});

describe("pointsPerFloor", () => {
  it("is the last week's average day", () => {
    expect(pointsPerFloor(1400, 204)).toBe(200);
  });

  it("is scale 1 when the average day is zero or very small", () => {
    expect(pointsPerFloor(0, 204)).toBe(204);
    expect(pointsPerFloor(MIN_AVERAGE_DAY_POINTS * 7 - 1, 204)).toBe(204);
  });
});

describe("the floor", () => {
  const seed = () => 7;

  it("starts empty on a first run", () => {
    const state = reconcileFloor(null, 900, 1400, 204, seed);
    expect(state).toEqual({ baseline: 900, pointsPerFloor: 200, meals: 0, seed: 7 });
    expect(floorDots(state, 900, 204)).toBe(0);
  });

  it("fills at the scaled rate and caps at the floor size", () => {
    const state = startFloor(1000, 1400, 204, 1);
    expect(floorScale(state, 204)).toBeCloseTo(1.02);
    expect(floorDots(state, 1100, 204)).toBe(102);
    expect(floorDots(state, 1199, 204)).toBe(202);
    expect(isFloorAwake(state, 1199, 204)).toBe(false);
    expect(floorDots(state, 1200, 204)).toBe(204);
    expect(floorDots(state, 5000, 204)).toBe(204);
    expect(isFloorAwake(state, 5000, 204)).toBe(true);
  });

  it("counts a point a dot at scale 1", () => {
    const state = startFloor(0, 0, 204, 1);
    expect(floorDots(state, 37.5, 204)).toBe(37);
  });

  it("keeps the same scale while the floor fills, whatever the week does", () => {
    const state = startFloor(0, 1400, 204, 1);
    expect(reconcileFloor(state, 100, 99_999, 204, seed)).toBe(state);
  });

  it("keeps its fill fraction when the grid changes size", () => {
    const state = startFloor(0, 1400, 204, 1);
    expect(floorDots(state, 100, 204)).toBe(102);
    expect(floorDots(state, 100, 208)).toBe(104);
  });

  it("carries anything past full into the next floor after a meal", () => {
    const state = startFloor(1000, 1400, 204, 1);
    const next = consumeMeal(state, 2800, 204, 9);
    expect(next).toEqual({ baseline: 1200, pointsPerFloor: 400, meals: 1, seed: 9 });
    // 1300 points: 100 past the first floor, at the new floor's scale.
    expect(floorDots(next, 1300, 204)).toBe(51);
  });

  it("counts exactly a floor after a meal with an awkward scale", () => {
    let state = startFloor(0, 7 * 33.3333, 204, 1);
    for (let i = 0; i < 5; i++) state = consumeMeal(state, 7 * 33.3333, 204, 1);
    expect(floorDots(state, 6 * 33.3333, 204)).toBe(204);
  });

  it("starts afresh when stats drop below the baseline", () => {
    const state = { ...startFloor(1000, 1400, 204, 1), meals: 3 };
    const next = reconcileFloor(state, 10, 0, 204, seed);
    expect(next).toEqual({ baseline: 10, pointsPerFloor: 204, meals: 3, seed: 7 });
    expect(floorDots(next, 10, 204)).toBe(0);
  });
});

describe("parseFloorState", () => {
  it("accepts a stored floor", () => {
    const state = { baseline: 12.5, pointsPerFloor: 200, meals: 2, seed: 44 };
    expect(parseFloorState(state)).toEqual(state);
  });

  it("rejects anything else", () => {
    expect(parseFloorState(null)).toBeNull();
    expect(parseFloorState("x")).toBeNull();
    expect(parseFloorState({ baseline: 1, pointsPerFloor: 0, meals: 0, seed: 1 })).toBeNull();
    expect(parseFloorState({ baseline: 1, pointsPerFloor: 2, meals: -1, seed: 1 })).toBeNull();
    expect(parseFloorState({ baseline: "1", pointsPerFloor: 2, meals: 0, seed: 1 })).toBeNull();
  });
});
