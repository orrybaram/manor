/**
 * Run `load` on the first call and share its promise with every caller after.
 *
 * A failed load is not cached: the next caller starts it again. A lazily
 * loaded chunk can fail on a transient error, and one bad fetch should not
 * cost the feature for the rest of the session.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
