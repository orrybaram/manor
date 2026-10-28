import { useSyncExternalStore } from "react";
import { isHalloweenWeek } from "../lib/cobwebs";
import { usePreferencesStore } from "../store/preferences-store";
import { useLayoutMode } from "./useLayoutMode";

// One clock for every tab and panel, ticking once a minute only while
// something is listening: dust grows by the minute, and that is fine enough.
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time, to the minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => now);
}

/**
 * Whether dust and cobwebs show at all: Halloween week, the setting on, and
 * anything but the phone layout.
 */
export function useHalloweenEffects(): boolean {
  const clock = useMinuteClock();
  const enabled = usePreferencesStore((s) => s.preferences.halloweenEffects);
  const phone = useLayoutMode() === "phone";
  return enabled && !phone && isHalloweenWeek(new Date(clock));
}
