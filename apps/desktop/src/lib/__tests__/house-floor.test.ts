import { describe, expect, it } from "vitest";
import {
  bucketPoints,
  consumeMeal,
  floorDots,
  floorGrid,
  isFloorAwake,
  localDay,
  MIN_POINTS_PER_FLOOR,
  parseFloorState,
  pointsPerFloor,
  startFloor,
  summaryDay,
  syncFloor,
  type HouseFloorState,
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

  it("scores the mock's busy day", () => {
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
    expect(pointsPerFloor(1400)).toBe(200);
  });

  it("never drops below the minimum, with no cliff", () => {
    expect(pointsPerFloor(0)).toBe(MIN_POINTS_PER_FLOOR);
    expect(pointsPerFloor(7 * 59)).toBe(MIN_POINTS_PER_FLOOR);
    expect(pointsPerFloor(7 * 61)).toBe(61);
  });
});

describe("summaryDay and localDay", () => {
  it("reads the day the summary's buckets are for", () => {
    const now = new Date(2026, 10, 18, 0, 5);
    expect(localDay(now)).toBe("2026-11-18");
    expect(
      summaryDay({ dailyPrsMerged: [{ day: "2026-11-16" }, { day: "2026-11-17" }] }, now),
    ).toBe("2026-11-17");
    expect(summaryDay({ dailyPrsMerged: [] }, now)).toBe("2026-11-18");
  });
});

describe("the floor", () => {
  const seed = () => 7;
  const D1 = "2026-11-17";
  const D2 = "2026-11-18";
  const at = (state: HouseFloorState | null, day: string, today: number, last7 = 1400) =>
    syncFloor(state, day, today, last7, seed);

  it("starts empty on a first run, whatever today already holds", () => {
    const state = at(null, D1, 90);
    expect(state).toEqual({
      day: D1,
      todayMax: 90,
      progress: 0,
      pointsPerFloor: 200,
      meals: 0,
      seed: 7,
    });
    expect(floorDots(state, 204)).toBe(0);
  });

  it("banks today's gains and fills at the scaled rate, capped", () => {
    let state = at(null, D1, 0);
    state = at(state, D1, 100);
    expect(floorDots(state, 204)).toBe(102);
    state = at(state, D1, 199);
    expect(floorDots(state, 204)).toBe(202);
    expect(isFloorAwake(state, 204)).toBe(false);
    state = at(state, D1, 500);
    expect(floorDots(state, 204)).toBe(204);
    expect(isFloorAwake(state, 204)).toBe(true);
  });

  it("returns the same state when nothing is gained", () => {
    const state = at(at(null, D1, 0), D1, 50);
    expect(at(state, D1, 50)).toBe(state);
    expect(at(state, D1, 10)).toBe(state);
  });

  it("doesn't jump when a host's history merges in after the first summary", () => {
    // First summary: only the desktop's own stats. All-time history from a
    // host doesn't touch today's bucket beyond the host's today.
    let state = at(null, D1, 40);
    state = at(state, D1, 55); // the host's 15 points today merge in
    expect(state.progress).toBe(15);
    expect(floorDots(state, 204)).toBe(15);
  });

  it("adds nothing for a dip and its recovery", () => {
    let state = at(at(null, D1, 0), D1, 80);
    state = at(state, D1, 30); // a host briefly missing
    state = at(state, D1, 80); // back
    expect(state.progress).toBe(80);
    state = at(state, D1, 0); // stats reset
    expect(state.progress).toBe(80);
    state = at(state, D1, 90); // past the old mark: only the excess counts
    expect(state.progress).toBe(90);
  });

  it("starts the mark at 0 on a new day", () => {
    let state = at(at(null, D1, 0), D1, 120);
    state = at(state, D2, 20);
    expect(state).toMatchObject({ day: D2, todayMax: 20, progress: 140 });
  });

  it("ignores a stale summary from an earlier day", () => {
    const state = at(at(null, D2, 0), D2, 30);
    expect(at(state, D1, 500)).toBe(state);
  });

  it("keeps the same points per floor while it fills, whatever the week does", () => {
    const state = at(at(null, D1, 0, 1400), D1, 100, 99_999);
    expect(state.pointsPerFloor).toBe(200);
  });

  it("keeps its fill fraction when the grid changes size", () => {
    const state = at(at(null, D1, 0), D1, 100);
    expect(floorDots(state, 204)).toBe(102);
    expect(floorDots(state, 208)).toBe(104);
  });

  it("carries anything past full into the next floor after a meal", () => {
    const state = at(at(null, D1, 0), D1, 300);
    const next = consumeMeal(state, 2800, 9);
    expect(next).toMatchObject({ progress: 100, pointsPerFloor: 400, meals: 1, seed: 9 });
    expect(floorDots(next, 204)).toBe(51);
  });

  it("counts exactly a floor after meals with an awkward size", () => {
    let state: HouseFloorState = { ...startFloor(D1, 0, 7 * 66.6667, 1), progress: 6 * 66.6667 };
    for (let i = 0; i < 5; i++) state = consumeMeal(state, 7 * 66.6667, 1);
    expect(floorDots(state, 204)).toBe(204);
  });
});

describe("parseFloorState", () => {
  const good = { day: "2026-11-17", todayMax: 12.5, progress: 40, pointsPerFloor: 200, meals: 2, seed: 44 };

  it("accepts a stored floor", () => {
    expect(parseFloorState(good)).toEqual(good);
  });

  it("rejects anything else", () => {
    expect(parseFloorState(null)).toBeNull();
    expect(parseFloorState("x")).toBeNull();
    expect(parseFloorState({ ...good, pointsPerFloor: 0 })).toBeNull();
    expect(parseFloorState({ ...good, meals: -1 })).toBeNull();
    expect(parseFloorState({ ...good, progress: "1" })).toBeNull();
    expect(parseFloorState({ ...good, day: "yesterday" })).toBeNull();
    // The earlier baseline shape.
    expect(parseFloorState({ baseline: 1, pointsPerFloor: 2, meals: 0, seed: 1 })).toBeNull();
  });
});
