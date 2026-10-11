/**
 * "Fetch your state again" (ADR-220 D1).
 *
 * Every store reads its state once and then lives on push events. A browser
 * socket that dropped and came back missed whatever was pushed while it was
 * gone, so `install-web.ts` emits this on every accepted hello after the
 * first, and on a manual refresh; each store re-runs its fetch.
 *
 * A plain listener set with no platform checks: the desktop never emits it,
 * so the listeners its stores register simply never fire.
 */

const listeners = new Set<() => void>();

/** Run `cb` on every resync. Returns the unsubscribe. */
export function onBridgeResync(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Tell every listener to re-fetch. Iterates a copy, so a listener that
 * unsubscribes mid-run does not skip its neighbour, and one that throws does
 * not stop the rest.
 */
export function emitBridgeResync(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.error("[bridge-resync] a resync listener threw", err);
    }
  }
}
