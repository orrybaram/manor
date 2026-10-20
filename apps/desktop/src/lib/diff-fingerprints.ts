/**
 * The latest diff fingerprint per workspace, as the main process's
 * DiffWatcher last sent it. It changes whenever a workspace's HEAD, base ref,
 * `git status` or the content of a changed or untracked file does, so a diff
 * pane fetches the full diff only then instead of on a timer.
 *
 * The main process sends only on change, so the latest map is kept here for
 * a pane that opens later. `useDiffWatcher` feeds it.
 */

import type { WorkspaceKey } from "./workspace-key";

let latest: Record<WorkspaceKey, string> = {};
const listeners = new Set<() => void>();

/** Replace every workspace's fingerprint (the whole map is sent each time). */
export function setDiffFingerprints(next: Record<WorkspaceKey, string>): void {
  latest = next;
  for (const listener of listeners) listener();
}

/**
 * Call `onChange` each time `key`'s fingerprint moves from one value to
 * another, from now on. Its first value, when the watcher had none for `key`
 * yet, does not count: the caller fetches once as it starts watching, and
 * that first fingerprint describes the workspace that fetch is reading.
 * Returns the unsubscribe.
 */
export function watchDiffFingerprint(key: WorkspaceKey, onChange: () => void): () => void {
  let seen: string | undefined = latest[key];
  const listener = () => {
    const next = latest[key];
    if (next === seen) return;
    const prev = seen;
    seen = next;
    if (prev !== undefined && next !== undefined) onChange();
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
