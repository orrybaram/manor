import { useCallback, useEffect } from "react";
import { create } from "zustand";
import {
  bucketPoints,
  consumeMeal,
  floorDots,
  floorGrid,
  parseFloorState,
  randomSeed,
  reconcileFloor,
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
  /** Start the floor on a first run, or afresh after stats were reset. */
  sync: (allTimePoints: number, last7DaysPoints: number) => void;
  /** Feed the house a full floor; no-op unless the floor is full. */
  eat: (allTimePoints: number, last7DaysPoints: number) => void;
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

  sync: (allTimePoints, last7DaysPoints) => {
    const { floor, grid } = get();
    const next = reconcileFloor(floor, allTimePoints, last7DaysPoints, grid.size, randomSeed);
    if (next === floor) return;
    saveHouseFloor(next);
    set({ floor: next });
  },

  eat: (allTimePoints, last7DaysPoints) => {
    const { floor, grid } = get();
    if (!floor || floorDots(floor, allTimePoints, grid.size) < grid.size) return;
    const next = consumeMeal(floor, last7DaysPoints, grid.size, randomSeed());
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
 * (empty on a first run) and keeps it in step with a stats reset.
 */
export function useHouseFloor(): HouseFloor {
  const summary = useStatsStore((s) => s.summary);
  const floor = useHouseFloorStore((s) => s.floor);
  const grid = useHouseFloorStore((s) => s.grid);

  const allTime = summary ? bucketPoints(summary.allTime) : null;
  const last7Days = summary ? bucketPoints(summary.last7Days) : 0;

  useEffect(() => {
    if (allTime !== null) useHouseFloorStore.getState().sync(allTime, last7Days);
  }, [allTime, last7Days]);

  const eat = useCallback(() => {
    if (allTime !== null) useHouseFloorStore.getState().eat(allTime, last7Days);
  }, [allTime, last7Days]);

  const dots = floor && allTime !== null ? floorDots(floor, allTime, grid.size) : 0;
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
