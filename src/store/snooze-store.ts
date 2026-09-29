import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

const SNOOZE_STORAGE_KEY = "manor.home.snoozes";

interface SnoozeState {
  until: Record<string, number>;
  snooze: (key: string, ms?: number) => void;
  activeSnoozes: (now?: number) => Set<string>;
}

/**
 * Load snoozes from localStorage, dropping any that have already expired.
 */
function loadSnoozes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SNOOZE_STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) return {};
    const until: Record<string, number> = {};
    const now = Date.now();
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "number" && value > now) {
        until[key] = value;
      }
    }
    return until;
  } catch {
    return {};
  }
}

/**
 * Persist snoozes to localStorage, dropping any that have expired.
 */
function persistSnoozes(until: Record<string, number>): void {
  try {
    const now = Date.now();
    const active: Record<string, number> = {};
    for (const [key, value] of Object.entries(until)) {
      if (value > now) {
        active[key] = value;
      }
    }
    localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(active));
  } catch {
    // fall back to in-memory store; do nothing
  }
}

export const useSnoozeStore = create<SnoozeState>((set, get) => ({
  until: loadSnoozes(),

  snooze: (key: string, ms: number = 60 * 60 * 1000) => {
    const until = Date.now() + ms;
    set((state) => ({
      until: { ...state.until, [key]: until },
    }));
    persistSnoozes(get().until);
  },

  activeSnoozes: (now: number = Date.now()) => {
    const active = new Set<string>();
    for (const [key, value] of Object.entries(get().until)) {
      if (value > now) {
        active.add(key);
      }
    }
    return active;
  },
}));

/**
 * Hook that returns the currently active snoozes. The set is derived from the
 * store, so a new snooze hides its card on the same render; a timeout for the
 * soonest future expiry bumps `now` so a lapsed snooze brings its card back.
 */
export function useActiveSnoozes(): Set<string> {
  const until = useSnoozeStore((s) => s.until);
  const [now, setNow] = useState(() => Date.now());

  // `now` only needs to be current at each expiry: the timeout below bumps
  // it then, and a new snooze always ends after it.
  const active = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(until)) {
      if (value > now) keys.add(key);
    }
    return keys;
  }, [until, now]);

  useEffect(() => {
    const at = Date.now();
    let soonest = Infinity;
    for (const expiry of Object.values(until)) {
      if (expiry > at && expiry < soonest) soonest = expiry;
    }
    if (soonest === Infinity) return;
    const timeout = setTimeout(() => setNow(Date.now()), soonest - at);
    return () => clearTimeout(timeout);
  }, [until, now]);

  return active;
}
