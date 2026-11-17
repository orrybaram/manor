import { useCallback, useEffect } from "react";
import { create } from "zustand";
import {
  bucketPoints,
  consumeMeal,
  floorDots,
  floorGrid,
  summaryDay,
  parseFloorState,
  randomSeed,
  syncFloor,
  type FloorGrid,
  type HouseFloorState,
} from "../lib/house-floor";
import { useStatsStore } from "./stats-store";

/** Per desktop: the renderer's own storage, never synced to hosts. */
export const HOUSE_FLOOR_KEY = "manor:houseFloor";
/** The full sidebar's default width, until the floor measures itself. */
const DEFAULT_FLOOR_WIDTH = 220;

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
  /** The floor's canvas reports its width; columns follow it. */
  setWidth: (width: number) => void;
  /**
   * Bank the new points in `day`'s bucket (local YYYY-MM-DD). A first run
   * starts an empty floor at today's points; drops are ignored.
   */
  sync: (day: string, todayPoints: number, last7DaysPoints: number) => void;
  /** Feed the house a full floor; no-op unless the floor is full. */
  eat: (last7DaysPoints: number) => void;
}

export const useHouseFloorStore = create<HouseFloorStore>((set, get) => ({
  floor: loadHouseFloor(),
  grid: floorGrid(DEFAULT_FLOOR_WIDTH),

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
    set({ floor: next });
  },
}));

export interface HouseFloor {
  /** Dots on the floor now, 0 to `floorSize`. */
  dots: number;
  floorSize: number;
  cols: number;
  rows: number;
  /** Full: it wakes and can be fed. */
  awake: boolean;
  meals: number;
  /** This floor's fill order and dot looks; changes with every new floor. */
  seed: number;
  /** Feed the full floor to the house: the next floor starts. */
  eat: () => void;
}

/**
 * The house floor for the current stats. Starts the floor once stats arrive
 * (empty on a first run) and banks today's gains as they come.
 */
export function useHouseFloor(): HouseFloor {
  const summary = useStatsStore((s) => s.summary);
  const floor = useHouseFloorStore((s) => s.floor);
  const grid = useHouseFloorStore((s) => s.grid);

  const day = summary ? summaryDay(summary, new Date()) : null;
  const today = summary ? bucketPoints(summary.today) : 0;
  const last7Days = summary ? bucketPoints(summary.last7Days) : 0;

  useEffect(() => {
    if (day !== null) useHouseFloorStore.getState().sync(day, today, last7Days);
  }, [day, today, last7Days]);

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
    meals: floor?.meals ?? 0,
    seed: floor?.seed ?? 0,
    eat,
  };
}
