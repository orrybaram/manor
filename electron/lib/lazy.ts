/**
 * Loading for code kept off the startup path (ADR-202): a dynamic `import()`
 * that runs once, on first use.
 */

/** A memoised async loader. */
export interface Lazy<T> {
  /** Start the load, or join the one already started. */
  (): Promise<T>;
  /** The load already started, if any. Never starts one. */
  started(): Promise<T> | null;
}

/**
 * Memoise `load`: the first call starts it and later calls share it. A failed
 * load is forgotten, so the next call retries rather than caching the failure
 * for the life of the app.
 */
export function lazy<T>(load: () => Promise<T>): Lazy<T> {
  let pending: Promise<T> | null = null;
  const get = (): Promise<T> => {
    if (!pending) {
      const loading = load();
      loading.catch(() => {
        if (pending === loading) pending = null;
      });
      pending = loading;
    }
    return pending;
  };
  return Object.assign(get, { started: () => pending });
}

/**
 * A dynamically imported CommonJS module's exports. Depending on the bundler
 * they sit on the namespace itself or under `default`; `probe` names an export
 * that tells the two apart.
 */
export function cjsExports<T extends object>(ns: T, probe: keyof T): T {
  if (ns[probe] !== undefined) return ns;
  return (ns as T & { default: T }).default;
}
