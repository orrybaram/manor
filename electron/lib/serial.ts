/**
 * A queue that runs async steps one at a time, in call order.
 */

/** Run `step` after every step queued before it has settled. */
export type Serially = <T>(step: () => T | Promise<T>) => Promise<T>;

/**
 * A new, empty queue. A failure rejects that caller only; the queue carries
 * on. A step must not queue onto its own queue and await it — that waits on
 * itself.
 */
export function serialQueue(): Serially {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(step: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(step);
    tail = run.catch(() => undefined);
    return run;
  };
}
