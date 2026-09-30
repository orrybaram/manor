/**
 * Single-flight fetching, shared by every diff pane.
 *
 * Only one fetch per key (workspace + mode + base) runs at a time. A request
 * made while one is in flight queues exactly one more, which starts once the
 * current fetch settles, so it sees every change requested so far; any later
 * request joins that queued fetch instead of stacking another.
 */

interface Slot<T> {
  current: Promise<T>;
  queued: Promise<T> | null;
}

export function createSingleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const slots = new Map<string, Slot<T>>();

  const launch = (key: string, run: () => Promise<T>): Promise<T> => {
    const current = run();
    const slot: Slot<T> = { current, queued: null };
    slots.set(key, slot);
    const settle = () => {
      if (slots.get(key) === slot && slot.queued === null) slots.delete(key);
    };
    current.then(settle, settle);
    return current;
  };

  return (key, run) => {
    const slot = slots.get(key);
    if (!slot) return launch(key, run);
    slot.queued ??= slot.current.then(
      () => launch(key, run),
      () => launch(key, run),
    );
    return slot.queued;
  };
}

/** The diff fetches of every open diff pane. */
export const fetchDiffOnce = createSingleFlight<string | null>();

/** The staged-file fetches of every open diff pane. */
export const fetchStagedOnce = createSingleFlight<string[]>();
