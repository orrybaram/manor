import { useState, useEffect, useRef } from "react";
import type { AgentStatus } from "../electron.d";

/**
 * Debounce transitions between "thinking" and "working" so the indicator
 * doesn't flicker when the agent rapidly alternates between the two.
 * All other transitions (to idle, complete, error, requires_input) are instant.
 */
const ACTIVE_STATUSES = new Set<AgentStatus>(["thinking", "working"]);
const DEBOUNCE_MS = 500;

export function useDebouncedAgentStatus(
  status: AgentStatus | undefined,
): AgentStatus | undefined {
  const [displayed, setDisplayed] = useState(status);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // If both old and new are active states, debounce the visual switch
    if (
      displayed &&
      status &&
      ACTIVE_STATUSES.has(displayed) &&
      ACTIVE_STATUSES.has(status) &&
      displayed !== status
    ) {
      timerRef.current = setTimeout(() => {
        setDisplayed(status);
        timerRef.current = null;
      }, DEBOUNCE_MS);

      return () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }

    // For any other transition, apply immediately
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setDisplayed(status);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return displayed;
}
