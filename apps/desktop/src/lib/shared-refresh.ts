/**
 * A refresh that runs one at a time, shared by every caller while it runs,
 * and that a window focus may skip when one started recently (#303).
 */
export interface SharedRefresh {
  /** Start a refresh, or join the one running. */
  run(): Promise<void>;
  /** `run`, but after the running refresh (which may be stale) instead of joining it. */
  runAfterCurrent(): Promise<void>;
  /**
   * `run`, unless none is running and the last started less than the
   * minimum interval ago — then null, and nothing runs.
   */
  runIfDue(): Promise<void> | null;
}

export function sharedRefresh(
  refresh: () => Promise<void>,
  minIntervalMs: number,
): SharedRefresh {
  let inFlight: Promise<void> | null = null;
  /** When the last refresh started; `-Infinity` before the first. */
  let lastStartedAt = -Infinity;

  const run = (): Promise<void> => {
    if (!inFlight) {
      lastStartedAt = Date.now();
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  return {
    run,
    runAfterCurrent: () => (inFlight ? inFlight.then(run) : run()),
    runIfDue: () => {
      if (!inFlight && Date.now() - lastStartedAt < minIntervalMs) return null;
      return run();
    },
  };
}
