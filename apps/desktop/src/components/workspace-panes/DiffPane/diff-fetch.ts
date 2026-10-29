/**
 * Single-flight fetching, shared by every diff pane.
 *
 * Only one fetch per key (workspace + mode + base) runs at a time. A request
 * made while one is in flight queues exactly one more, which starts once the
 * current fetch settles, so it sees every change requested so far; any later
 * request joins that queued fetch instead of stacking another. A request in
 * the same task as the launch (every pane hearing one fingerprint move) joins
 * the fetch just started: nothing can have changed in between.
 */

interface Slot<T> {
  current: Promise<T>;
  queued: Promise<T> | null;
  /** Launched in this task, so a request now still sees all it would. */
  joinable: boolean;
}

export function createSingleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const slots = new Map<string, Slot<T>>();

  const launch = (key: string, run: () => Promise<T>): Promise<T> => {
    const current = run();
    const slot: Slot<T> = { current, queued: null, joinable: true };
    slots.set(key, slot);
    queueMicrotask(() => {
      slot.joinable = false;
    });
    const settle = () => {
      if (slots.get(key) === slot && slot.queued === null) slots.delete(key);
    };
    current.then(settle, settle);
    return current;
  };

  return (key, run) => {
    const slot = slots.get(key);
    if (!slot) return launch(key, run);
    if (slot.joinable) return slot.current;
    slot.queued ??= slot.current.then(
      () => launch(key, run),
      () => launch(key, run),
    );
    return slot.queued;
  };
}

/**
 * The key of a workspace's local diff (vs. HEAD), which has no base branch:
 * every diff pane in Local mode and the file pane's change marks share it.
 */
export function localDiffKey(wsKey: string): string {
  return `${wsKey}\u0000local`;
}

/** The diff fetches of every open diff pane, and the file pane's change marks. */
export const fetchDiffSingleFlight = createSingleFlight<string | null>();

/** The staged-file fetches of every open diff pane. */
export const fetchStagedSingleFlight = createSingleFlight<string[]>();
