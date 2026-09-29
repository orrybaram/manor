import { useEffect, useState } from "react";
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
 * Hook that returns the currently active snoozes and re-renders when a snooze
 * expires. Schedules a timeout for the soonest expiry and clears it on unmount.
 */
export function useActiveSnoozes(): Set<string> {
  const until = useSnoozeStore((s) => s.until);
  const [active, setActive] = useState<Set<string>>(() => {
    const store = useSnoozeStore.getState();
    return store.activeSnoozes();
  });

  useEffect(() => {
    const updateActive = () => {
      const store = useSnoozeStore.getState();
      setActive(store.activeSnoozes());
    };

    // Find the soonest expiry
    let soonest = Infinity;
    for (const expiry of Object.values(until)) {
      if (expiry < soonest) {
        soonest = expiry;
      }
    }

    // If there are no active snoozes, don't schedule a timeout
    if (soonest === Infinity) {
      return;
    }

    const now = Date.now();
    const delay = Math.max(0, soonest - now);

    // Schedule the timeout for the soonest expiry
    const timeout = setTimeout(() => {
      updateActive();
    }, delay);

    return () => {
      clearTimeout(timeout);
    };
  }, [until]);

  return active;
}
