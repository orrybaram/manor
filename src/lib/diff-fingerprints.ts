/**
 * The latest diff fingerprint per workspace, as the main process's
 * DiffWatcher last sent it. It changes whenever a workspace's HEAD, base ref
 * or shortstat does, so a diff pane fetches the full diff only then instead
 * of on a timer.
 *
 * The main process sends only on change, so the latest map is kept here for
 * a pane that opens later. `useDiffWatcher` feeds it.
 */

import { useSyncExternalStore } from "react";
import type { WorkspaceKey } from "./workspace-key";

let latest: Record<WorkspaceKey, string> = {};
const listeners = new Set<() => void>();

/** Replace every workspace's fingerprint (the whole map is sent each time). */
export function setDiffFingerprints(next: Record<WorkspaceKey, string>): void {
  latest = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `key`'s fingerprint, or undefined while the watcher has none for it. */
export function useDiffFingerprint(key: WorkspaceKey | null): string | undefined {
  return useSyncExternalStore(subscribe, () => (key === null ? undefined : latest[key]));
}
