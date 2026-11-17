import type { DayBucket, StatCounter } from "../electron.d";

/**
 * The house floor: a grid of dots at the end of the sidebar's Agents list.
 * Things that end during the day (agents killed, worktrees removed, PRs
 * merged…) fill it; once it is full it wakes and can be fed. Feeding is
 * pretend: it moves only the floor's own baseline, never stats or sessions.
 *
 * Progress is banked from today's stats bucket as a per-day high-water mark,
 * so it only ever moves forward: a summary that briefly lacks a host, a
 * host's history merging in, or a stats reset can't empty or flood the floor.
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
 * The fewest points a floor takes, however quiet the last week was: a
 * near-idle user fills one in a few days, and one kill never fills a floor.
 */
export const MIN_POINTS_PER_FLOOR = 60;

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

/** What's persisted per desktop (`manor:houseFloor`). */
export interface HouseFloorState {
  /** The local day (YYYY-MM-DD) `todayMax` belongs to. */
  day: string;
  /** The most points today's bucket has shown; gains past it are banked. */
  todayMax: number;
  /** Points banked toward the current floor; past a floor carries over. */
  progress: number;
  /** Points that fill this floor, set when it started. */
  pointsPerFloor: number;
  /** Floors fed so far. */
  meals: number;
  /** Seeds this floor's fill order and dot looks. */
  seed: number;
}

/** A date's local day, YYYY-MM-DD. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The local day a summary's `today` bucket is for: the last day of its
 * `dailyPrsMerged` (today and the previous 6), so a summary cached across
 * midnight isn't read as the new day. `now`'s day when it has none.
 */
export function summaryDay(
  summary: { dailyPrsMerged?: readonly { day: string }[] },
  now: Date,
): string {
  const days = summary.dailyPrsMerged;
  return days?.[days.length - 1]?.day ?? localDay(now);
}

/**
 * Points a floor takes, set when it starts: the last 7 days' average day, so
 * a typical day fills about one floor, but never fewer than
 * `MIN_POINTS_PER_FLOOR`.
 */
export function pointsPerFloor(last7DaysPoints: number): number {
  const averageDay = last7DaysPoints / 7;
  return Number.isFinite(averageDay)
    ? Math.max(averageDay, MIN_POINTS_PER_FLOOR)
    : MIN_POINTS_PER_FLOOR;
}

/** A first run: an empty floor that fills from today's points onward. */
export function startFloor(
  day: string,
  todayPoints: number,
  last7DaysPoints: number,
  seed: number,
): HouseFloorState {
  return {
    day,
    todayMax: todayPoints,
    progress: 0,
    pointsPerFloor: pointsPerFloor(last7DaysPoints),
    meals: 0,
    seed,
  };
}

/**
 * Bank today's new points. A new day starts its high-water mark at 0
 * (yesterday's gains were banked as they came); a drop in today's points
 * (a host missing from the summary, a stats reset) is ignored, and getting
 * back to the old mark adds nothing. Returns `state` itself when nothing changes.
 */
export function syncFloor(
  state: HouseFloorState | null,
  day: string,
  todayPoints: number,
  last7DaysPoints: number,
  nextSeed: () => number,
): HouseFloorState {
  if (!state) return startFloor(day, todayPoints, last7DaysPoints, nextSeed());
  // A summary from an earlier day (stale, out of order) banks nothing.
  if (day < state.day) return state;
  let next = state;
  if (next.day !== day) next = { ...next, day, todayMax: 0 };
  if (Number.isFinite(todayPoints) && todayPoints > next.todayMax) {
    next = {
      ...next,
      progress: next.progress + (todayPoints - next.todayMax),
      todayMax: todayPoints,
    };
  }
  return next;
}

/** Dots on the floor: `floor(progress / pointsPerFloor × floorSize)`, 0 to `floorSize`. */
export function floorDots(state: HouseFloorState, floorSize: number): number {
  const raw = (state.progress / state.pointsPerFloor) * floorSize;
  // A hair of slack so a float sum still counts the dot it should
  // (e.g. 203.9999999 is 204).
  const dots = Math.floor(raw + 1e-6);
  return Math.max(0, Math.min(floorSize, dots));
}

/** Full floors wake and can be fed. */
export function isFloorAwake(state: HouseFloorState, floorSize: number): boolean {
  return floorDots(state, floorSize) >= floorSize;
}

/**
 * The house ate this floor. Progress drops by exactly one floor of points,
 * so anything past full carries into the next; the next floor's size in
 * points is set now, from the latest week.
 */
export function consumeMeal(
  state: HouseFloorState,
  last7DaysPoints: number,
  seed: number,
): HouseFloorState {
  return {
    ...state,
    progress: Math.max(0, state.progress - state.pointsPerFloor),
    pointsPerFloor: pointsPerFloor(last7DaysPoints),
    meals: state.meals + 1,
    seed,
  };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A stored value, or `null` when it's missing or not a floor. */
export function parseFloorState(raw: unknown): HouseFloorState | null {
  if (!raw || typeof raw !== "object") return null;
  const { day, todayMax, progress, pointsPerFloor: perFloor, meals, seed } =
    raw as Record<string, unknown>;
  if (
    typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !isFiniteNumber(todayMax) || todayMax < 0 ||
    !isFiniteNumber(progress) || progress < 0 ||
    !isFiniteNumber(perFloor) || perFloor <= 0 ||
    typeof meals !== "number" || !Number.isInteger(meals) || meals < 0 ||
    typeof seed !== "number" || !Number.isInteger(seed)
  ) {
    return null;
  }
  return { day, todayMax, progress, pointsPerFloor: perFloor, meals, seed };
}

/** A seed for a new floor's fill order. */
export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 2_147_483_646);
}
