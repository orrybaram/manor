import { useCallback } from "react";
import { create } from "zustand";
import {
  bucketPoints,
  consumeMeal,
  floorDots,
  floorGrid,
  HOUSE_SETTLE_MS,
  summaryDay,
  parseFloorState,
  randomSeed,
  syncFloor,
  type FloorGrid,
  type HouseFloorState,
} from "../lib/house-floor";
import type { StatsSummary } from "../electron.d";
import { useStatsStore } from "./stats-store";

/** Per desktop: the renderer's own storage, never synced to hosts. */
export const HOUSE_FLOOR_KEY = "manor:houseFloor";
/**
 * The full sidebar's default width (220) less the floor's scrollbar
 * allowance, until the floor measures itself.
 */
const DEFAULT_FLOOR_WIDTH = 208;

export function loadHouseFloor(): HouseFloorState | null {
  try {
    const raw = localStorage.getItem(HOUSE_FLOOR_KEY);
    return raw ? parseFloorState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveHouseFloor(state: HouseFloorState): void {
  try {
    localStorage.setItem(HOUSE_FLOOR_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

interface HouseFloorStore {
  /** `null` until stats first arrive (a first run starts the floor then). */
  floor: HouseFloorState | null;
  /** The grid at the floor's last measured width. */
  grid: FloorGrid;
  /**
   * Settle is playing: the floor is already eaten (and may be empty), but
   * the Agents section stays up until the house has answered. Set in the
   * same update as the meal and cleared by the store's own timer, so no
   * render in between can drop the floor. Not persisted.
   */
  settling: boolean;
  /** The floor's canvas reports its width; columns follow it. */
  setWidth: (width: number) => void;
  /**
   * Bank the new points in `day`'s bucket (local YYYY-MM-DD). A first run
   * starts an empty floor at today's points; drops are ignored.
   */
  sync: (day: string, todayPoints: number, last7DaysPoints: number) => void;
  /**
   * Feed the house a full floor and start Settle (`HOUSE_SETTLE_MS`); no-op
   * unless the floor is full.
   */
  eat: (last7DaysPoints: number) => void;
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;

export const useHouseFloorStore = create<HouseFloorStore>((set, get) => ({
  floor: loadHouseFloor(),
  grid: floorGrid(DEFAULT_FLOOR_WIDTH),
  settling: false,

  setWidth: (width) => {
    const grid = floorGrid(width);
    const current = get().grid;
    if (grid.cols === current.cols && grid.rows === current.rows) return;
    set({ grid });
  },

  sync: (day, todayPoints, last7DaysPoints) => {
    const { floor } = get();
    const next = syncFloor(floor, day, todayPoints, last7DaysPoints, randomSeed);
    if (next === floor) return;
    saveHouseFloor(next);
    set({ floor: next });
  },

  eat: (last7DaysPoints) => {
    const { floor, grid } = get();
    if (!floor || floorDots(floor, grid.size) < grid.size) return;
    const next = consumeMeal(floor, last7DaysPoints, randomSeed());
    saveHouseFloor(next);
    set({ floor: next, settling: true });
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      set({ settling: false });
    }, HOUSE_SETTLE_MS);
  },
}));

/** Bank a summary's new points into the floor. */
function bank(summary: StatsSummary | null): void {
  if (!summary) return;
  useHouseFloorStore
    .getState()
    .sync(summaryDay(summary, new Date()), bucketPoints(summary.today), bucketPoints(summary.last7Days));
}

/**
 * Banks every stats summary while the renderer is open, whether or not the
 * floor is on screen (rail sidebar, phone layout, no projects), so a day's
 * gains are never missed. Returns the unsubscribe.
 */
export function startHouseFloorBanking(): () => void {
  bank(useStatsStore.getState().summary);
  return useStatsStore.subscribe((state, prev) => {
    if (state.summary !== prev.summary) bank(state.summary);
  });
}

// Started once, when the renderer loads this module (and again after a hot
// reload replaces it, so the old subscription goes with the old module).
const stopBanking = startHouseFloorBanking();
import.meta.hot?.dispose(stopBanking);

export interface HouseFloor {
  /** Dots on the floor now, 0 to `floorSize`. */
  dots: number;
  floorSize: number;
  cols: number;
  rows: number;
  /** Full: it wakes and can be fed. */
  awake: boolean;
  /** Settle is playing over a floor already eaten. */
  settling: boolean;
  meals: number;
  /** This floor's fill order and dot looks; changes with every new floor. */
  seed: number;
  /** Feed the full floor to the house: the next floor starts. */
  eat: () => void;
}

/**
 * The house floor, for reading. Banking happens on its own
 * (`startHouseFloorBanking`); this only reads the floor and feeds it.
 */
export function useHouseFloor(): HouseFloor {
  const last7Days = useStatsStore((s) => (s.summary ? bucketPoints(s.summary.last7Days) : 0));
  const floor = useHouseFloorStore((s) => s.floor);
  const grid = useHouseFloorStore((s) => s.grid);
  const settling = useHouseFloorStore((s) => s.settling);

  const eat = useCallback(() => {
    useHouseFloorStore.getState().eat(last7Days);
  }, [last7Days]);

  const dots = floor ? floorDots(floor, grid.size) : 0;
  return {
    dots,
    floorSize: grid.size,
    cols: grid.cols,
    rows: grid.rows,
    awake: dots >= grid.size,
    settling,
    meals: floor?.meals ?? 0,
    seed: floor?.seed ?? 0,
    eat,
  };
}
