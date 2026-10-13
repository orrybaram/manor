/**
 * "Fetch your state again" (ADR-220 D1), and the manual refresh (D5).
 *
 * Every store reads its state once and then lives on push events. A browser
 * socket that dropped and came back missed whatever was pushed while it was
 * gone, so `install-web.ts` emits this on every accepted hello after the
 * first, and on a manual refresh; each store re-runs its fetch.
 *
 * Desktop-safe, with no platform checks: the desktop never emits a resync and
 * never registers a refresher, so the listeners its stores register simply
 * never fire and a refresh is a no-op. `install-web.ts` installs
 * `window.electronAPI` as a side effect of being imported, so a component
 * shared with the desktop reaches the refresh through here, never through it.
 */

type ResyncListener = () => void | Promise<unknown>;

const listeners = new Set<ResyncListener>();

/**
 * Run `cb` on every resync. A listener that returns a promise holds the
 * emit's own promise until it settles. Returns the unsubscribe.
 */
export function onBridgeResync(cb: ResyncListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Tell every listener to re-fetch; resolves once every listener's re-fetch
 * has settled, however it settled. Iterates a copy, so a listener that
 * unsubscribes mid-run does not skip its neighbour, and one that throws does
 * not stop the rest.
 */
export async function emitBridgeResync(): Promise<void> {
  const runs: Promise<unknown>[] = [];
  for (const cb of [...listeners]) {
    try {
      runs.push(Promise.resolve(cb()));
    } catch (err) {
      console.error("[bridge-resync] a resync listener threw", err);
    }
  }
  await Promise.allSettled(runs);
}

/**
 * Load now and again on every resync: the "read once, then live on pushes"
 * boot every store shares. A rejected async `load` is swallowed, so a failed
 * refetch keeps the held state. Returns the unsubscribe.
 */
export function bootAndResync(load: () => void | Promise<unknown>): () => void {
  const run = (): Promise<void> => {
    try {
      return Promise.resolve(load()).then(
        () => {},
        () => {},
      );
    } catch {
      // a sync throw keeps the held state, like a rejection
      return Promise.resolve();
    }
  };
  void run();
  return onBridgeResync(run);
}

/**
 * A value main both answers (`fetch`) and pushes (`onPush`), kept in one
 * place by `apply`: fetched at boot and on every resync, and live on pushes
 * in between. A push that lands while a fetch is in flight is newer than
 * what that fetch carries, so the fetch is dropped. Nothing applies after
 * the returned stop.
 */
export function liveValue<T>(
  fetch: () => Promise<T>,
  onPush: (cb: (value: T) => void) => () => void,
  apply: (value: T) => void,
): () => void {
  let pushes = 0;
  let stopped = false;
  const unsubscribePush = onPush((value) => {
    pushes += 1;
    if (!stopped) apply(value);
  });
  const unsubscribeResync = bootAndResync(async () => {
    const before = pushes;
    const value = await fetch();
    if (!stopped && pushes === before) apply(value);
  });
  return () => {
    stopped = true;
    unsubscribePush();
    unsubscribeResync();
  };
}

let refresher: (() => Promise<void>) | null = null;

/** Called by `install-web.ts` with the real refresh. */
export function registerRefresh(fn: () => Promise<void>): void {
  refresher = fn;
}

/** Refresh the bridge's state; resolves when every store has re-fetched. */
export async function refreshState(): Promise<void> {
  await refresher?.();
}
