const STORAGE_KEY = "manor:lastSeenVersion";

let justUpdated: boolean | null = null;

/**
 * True once when the app has relaunched on a version it has not run before —
 * the update landed, so the changelog is worth putting in front of the user,
 * who never asked to read it. The call also acknowledges it: later calls in
 * this renderer answer false, so a surface that remounts (the status bar leaves
 * and returns when the window crosses the phone breakpoint) doesn't pop it
 * open again.
 *
 * The stored version is read and stamped on the first call only, so a fresh
 * install (nothing stored) stays quiet — a first launch, not an update.
 */
export function takeJustUpdated(): boolean {
  if (justUpdated === null) {
    let previous: string | null = null;
    try {
      previous = localStorage.getItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, __APP_VERSION__);
    } catch {
      // Storage unavailable: say nothing rather than nag on every launch.
    }
    justUpdated = previous !== null && previous !== __APP_VERSION__;
  }

  const result = justUpdated;
  justUpdated = false;
  return result;
}
