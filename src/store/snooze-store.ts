import { useMemo } from "react";
import { create } from "zustand";

const SNOOZE_STORAGE_KEY = "manor.home.snoozes";

/**
 * Snoozed Needs you cards (ADR-198 §4): item key → epoch ms the snooze ends.
 * Invariant: `until` holds only unexpired entries. The store drops each one
 * when it lapses (see `scheduleExpiry`), so a component reading `until`
 * never needs its own clock.
 */
interface SnoozeState {
  until: Record<string, number>;
  snooze: (key: string, ms?: number) => void;
}

/** The entries of `until` still in force at `now`. */
function unexpired(until: Record<string, unknown>, now: number): Record<string, number> {
  const active: Record<string, number> = {};
  for (const [key, value] of Object.entries(until)) {
    if (typeof value === "number" && value > now) active[key] = value;
  }
  return active;
}

function loadSnoozes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SNOOZE_STORAGE_KEY);
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return {};
    return unexpired(data as Record<string, unknown>, Date.now());
  } catch {
    return {};
  }
}

function persistSnoozes(until: Record<string, number>): void {
  try {
    localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(until));
  } catch {
    // Storage unavailable: snoozes still work in memory for this session.
  }
}

export const useSnoozeStore = create<SnoozeState>((set, get) => ({
  until: loadSnoozes(),

  snooze: (key: string, ms: number = 60 * 60 * 1000) => {
    const now = Date.now();
    set((state) => ({ until: { ...unexpired(state.until, now), [key]: now + ms } }));
    persistSnoozes(get().until);
    scheduleExpiry();
  },
}));

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * One timer, for the soonest expiry. When it fires, drop every lapsed entry
 * (bringing those cards back) and schedule the next.
 */
function scheduleExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const expiries = Object.values(useSnoozeStore.getState().until);
  if (expiries.length === 0) return;
  const delay = Math.max(0, Math.min(...expiries) - Date.now());
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    const until = unexpired(useSnoozeStore.getState().until, Date.now());
    useSnoozeStore.setState({ until });
    persistSnoozes(until);
    scheduleExpiry();
  }, delay);
}

scheduleExpiry();

/** The keys snoozed right now; re-renders when a snooze starts or lapses. */
export function useActiveSnoozes(): Set<string> {
  const until = useSnoozeStore((s) => s.until);
  return useMemo(() => new Set(Object.keys(until)), [until]);
}
