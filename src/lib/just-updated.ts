const STORAGE_KEY = "manor:lastSeenVersion";

let justUpdated: boolean | null = null;

/**
 * True when the app has relaunched on a version it has not run before — the
 * update landed, so the changelog is worth putting in front of the user, who
 * never asked to read it.
 *
 * Answered once per renderer: reading and stamping the stored version is a
 * one-shot side effect, and a second pass (StrictMode double-invokes state
 * initialisers) would see the version it just wrote and conclude nothing had
 * changed. A fresh install has nothing stored — a first launch, not an
 * update, so it stays quiet.
 */
export function hasJustUpdated(): boolean {
  if (justUpdated !== null) return justUpdated;

  let previous: string | null = null;
  try {
    previous = localStorage.getItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, __APP_VERSION__);
  } catch {
    // Storage unavailable: say nothing rather than nag on every launch.
  }

  justUpdated = previous !== null && previous !== __APP_VERSION__;
  return justUpdated;
}
