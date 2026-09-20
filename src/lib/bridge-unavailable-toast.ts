/**
 * The once-per-session toast for a refused bridge call (ADR-178 ticket 9).
 *
 * Extracted from `app-store.ts`'s `layout.save` handling (ticket 6): the web
 * bridge answers a handful of fire-and-forget calls with the same
 * `BridgeUnavailableError` on every attempt (a preference toggle, a
 * keybinding edit), and a toast per attempt would just restate the same fact
 * every time a debounce fires. `shownIds` is keyed so unrelated refusals (one
 * for layout, one for preferences) each still get their own first toast.
 */

import { BridgeUnavailableError } from "../bridge/client";
import { useToastStore } from "../store/toast-store";

const shownIds = new Set<string>();

/** Show `message` as an error toast, once per session, keyed by `id`. */
export function showBridgeUnavailableToastOnce(
  id: string,
  message: string,
): void {
  if (shownIds.has(id)) return;
  shownIds.add(id);
  useToastStore.getState().addToast({ id, status: "error", message });
}

/**
 * A `.catch` handler for a fire-and-forget bridge call.
 *
 * A `BridgeUnavailableError` becomes the once-per-session toast above;
 * anything else is rethrown, so a real failure surfaces as an unhandled
 * rejection instead of being swallowed by a catch block that only meant to
 * handle one specific, expected refusal.
 */
export function handleBridgeUnavailable(
  id: string,
  message: string,
): (err: unknown) => void {
  return (err: unknown) => {
    if (err instanceof BridgeUnavailableError) {
      showBridgeUnavailableToastOnce(id, message);
      return;
    }
    throw err;
  };
}
