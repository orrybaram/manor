import { useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";

/**
 * The current time, refreshed every `intervalMs`. Card ages and the header
 * date are derived from it, so they move without a store update (an agent
 * waiting on you doesn't push anything while it waits).
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useMountEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  });

  return now;
}
