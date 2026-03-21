import { useEffect } from 'react';

/**
 * Run an effect once on mount. Use this instead of `useEffect` directly.
 *
 * We are progressively banning `useEffect` — most uses are better served by
 * derived state, event handlers, `useSyncExternalStore`, or data-fetching hooks.
 * `useMountEffect` covers the remaining case: syncing with an external system
 * exactly once when the component mounts.
 */
export function useMountEffect(effect: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, []);
}
