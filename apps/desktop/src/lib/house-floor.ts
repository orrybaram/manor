import type { DayBucket, StatCounter } from "../electron.d";

/**
 * The house floor: a grid of dots at the end of the sidebar's Agents list.
 * Things that end during the day (agents killed, worktrees removed, PRs
 * merged…) fill it; once it is full it wakes and can be fed. Feeding is
 * pretend: it moves only the floor's own baseline, never stats or sessions.
 *
 * Everything here is pure. Persistence is `store/house-floor-store.ts`.
 */

/** Points each counter is worth. `tokens` is per token: 1 point per 100k. */
export const POINT_WEIGHTS: Readonly<Partial<Record<StatCounter, number>>> = {
  agentsKilled: 2,
  agentsKilledMidThought: 3,
  subagents: 0.5,
  worktreesRemoved: 3,
  prsMerged: 2,
  prChecksFailed: 1,
  tokens: 1 / 100_000,
};

/** Distance between neighbouring sockets, in CSS pixels. */
export const FLOOR_PITCH = 13;
/** About how many sockets a floor has; always rounded to whole rows. */
export const FLOOR_TARGET = 200;
/** Horizontal room kept clear around the grid (both sides together). */
const FLOOR_SIDE_ROOM = 24;
const MIN_COLS = 4;
const MIN_ROWS = 3;
/**
 * An average day below this many points is "very small": the scale is 1
 * (a point a dot), so a quiet week doesn't make one kill fill a floor.
 */
export const MIN_AVERAGE_DAY_POINTS = 10;

/** Weighted points in one stats bucket. */
export function bucketPoints(bucket: DayBucket): number {
  let points = 0;
  for (const [counter, weight] of Object.entries(POINT_WEIGHTS)) {
    const value = bucket[counter as StatCounter] ?? 0;
    if (Number.isFinite(value) && value > 0) points += value * (weight ?? 0);
  }
  return points;
}

export interface FloorGrid {
  cols: number;
  rows: number;
  /** `cols × rows`: the sockets on the floor. */
  size: number;
}

/** Whole rows: however many columns fit `width` at the pitch, × round(200 / cols). */
export function floorGrid(width: number): FloorGrid {
  const usable = Number.isFinite(width) ? width : 0;
  const cols = Math.max(MIN_COLS, Math.floor((usable - FLOOR_SIDE_ROOM) / FLOOR_PITCH) + 1);
  const rows = Math.max(MIN_ROWS, Math.round(FLOOR_TARGET / cols));
  return { cols, rows, size: cols * rows };
}

/**
 * What's persisted per desktop (`manor:houseFloor`).
 *
 * The spec's `scale` (dots per point) is kept as its inverse,
 * `pointsPerFloor`, so the floor keeps its fill fraction when the sidebar is
 * resized and the grid gains or loses a column: `scale = floorSize /
 * pointsPerFloor`.
 */
export interface HouseFloorState {
  /** All-time points at which this floor started (empty). */
  baseline: number;
  /** Points that fill this floor: the average day when the floor started. */
  pointsPerFloor: number;
  /** Floors fed so far. */
  meals: number;
  /** Seeds this floor's fill order and dot looks. */
  seed: number;
}

/**
 * Points a floor takes, set when it starts: the last 7 days' average day,
 * so a typical day fills about one floor. A very small average gives scale 1
 * (one point, one dot).
 */
export function pointsPerFloor(last7DaysPoints: number, floorSize: number): number {
  const averageDay = last7DaysPoints / 7;
  if (!Number.isFinite(averageDay) || averageDay < MIN_AVERAGE_DAY_POINTS) return floorSize;
  return averageDay;
}

/** Dots per point on this floor at `floorSize`. */
export function floorScale(state: HouseFloorState, floorSize: number): number {
  return floorSize / state.pointsPerFloor;
}

/** A fresh, empty floor starting at `allTimePoints`. */
export function startFloor(
  allTimePoints: number,
  last7DaysPoints: number,
  floorSize: number,
  seed: number,
  meals = 0,
): HouseFloorState {
  return {
    baseline: allTimePoints,
    pointsPerFloor: pointsPerFloor(last7DaysPoints, floorSize),
    meals,
    seed,
  };
}

/**
 * The floor for the latest stats: a first run starts empty at the current
 * points, and stats that dropped below the baseline (reset) start a fresh
 * floor there. Returns `state` itself when nothing changes.
 */
export function reconcileFloor(
  state: HouseFloorState | null,
  allTimePoints: number,
  last7DaysPoints: number,
  floorSize: number,
  nextSeed: () => number,
): HouseFloorState {
  if (!state) return startFloor(allTimePoints, last7DaysPoints, floorSize, nextSeed());
  if (allTimePoints < state.baseline) {
    return startFloor(allTimePoints, last7DaysPoints, floorSize, nextSeed(), state.meals);
  }
  return state;
}

/** Dots on the floor: `floor((allTime − baseline) × scale)`, 0 to `floorSize`. */
export function floorDots(state: HouseFloorState, allTimePoints: number, floorSize: number): number {
  const raw = (allTimePoints - state.baseline) * floorScale(state, floorSize);
  // A hair of slack so a baseline moved by a float division still counts the
  // dot it should (e.g. 203.9999999 is 204).
  const dots = Math.floor(raw + 1e-6);
  return Math.max(0, Math.min(floorSize, dots));
}

/** Full floors wake and can be fed. */
export function isFloorAwake(state: HouseFloorState, allTimePoints: number, floorSize: number): boolean {
  return floorDots(state, allTimePoints, floorSize) >= floorSize;
}

/**
 * The house ate this floor. The baseline moves forward by exactly one floor
 * of points, so anything past full carries into the next; the next floor's
 * scale is set now, from the latest week.
 */
export function consumeMeal(
  state: HouseFloorState,
  last7DaysPoints: number,
  floorSize: number,
  seed: number,
): HouseFloorState {
  return {
    baseline: state.baseline + state.pointsPerFloor,
    pointsPerFloor: pointsPerFloor(last7DaysPoints, floorSize),
    meals: state.meals + 1,
    seed,
  };
}

/** A stored value, or `null` when it's missing or not a floor. */
export function parseFloorState(raw: unknown): HouseFloorState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const { baseline, pointsPerFloor: perFloor, meals, seed } = value;
  if (
    typeof baseline !== "number" || !Number.isFinite(baseline) ||
    typeof perFloor !== "number" || !Number.isFinite(perFloor) || perFloor <= 0 ||
    typeof meals !== "number" || !Number.isInteger(meals) || meals < 0 ||
    typeof seed !== "number" || !Number.isInteger(seed)
  ) {
    return null;
  }
  return { baseline, pointsPerFloor: perFloor, meals, seed };
}

/** A seed for a new floor's fill order. */
export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 2_147_483_646);
}
