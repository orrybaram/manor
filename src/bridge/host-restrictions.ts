/**
 * Whether the host this tab is connected to has refused anything as
 * `unavailable:host` (ADR-218 D5, D6): a host server serves only a slice of
 * the desktop's bridge, so a phone paired with one can browse and drive
 * existing agents but cannot create workspaces or launch new agents.
 *
 * The client reports a refusal here from the one place that decodes result
 * frames (`settle` in `client.ts`); entry points that would only round-trip
 * to the same refusal read it and state the limit instead. A page serves one
 * host (switching reloads), so the flag never needs resetting.
 */

import { useSyncExternalStore } from "react";
import { useToastStore } from "../store/toast-store";

/** What an entry point says in place of an action the host does not do. */
export const HOST_UNAVAILABLE_COPY =
  "Not yet available from the phone for remote hosts";

let restricted = false;
const listeners = new Set<() => void>();

export function markHostRestricted(): void {
  if (restricted) return;
  restricted = true;
  for (const cb of [...listeners]) cb();
}

export function isHostRestricted(): boolean {
  return restricted;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useHostRestricted(): boolean {
  return useSyncExternalStore(subscribe, isHostRestricted, () => false);
}

/**
 * Run `action` unless the host is known to refuse it, in which case say so
 * with a toast. For the desktop and unrestricted hosts it is just `action()`.
 */
export function unlessHostRestricted(action: () => void): void {
  if (!restricted) {
    action();
    return;
  }
  useToastStore.getState().addToast({
    id: "host-restricted",
    status: "error",
    message: HOST_UNAVAILABLE_COPY,
  });
}
