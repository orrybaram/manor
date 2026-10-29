/**
 * Which files a workspace has, for the terminal's path links: one
 * `files.list` per workspace, kept until the workspace changes, rather than a
 * read per hover.
 *
 * Only a workspace's first listing is waited for. After that a lookup
 * answers from the listing in hand and lists again in the background when
 * the workspace has changed, so a hover never waits on git (or the relay).
 * Most misses are not files at all (`v20.1`, `a@b.com`, a gitignored path),
 * so a miss alone lists again only once the listing is `MISS_REFRESH_MS` old.
 */

import type { FilesWorkspace } from "../components/workspace-panes/FilePane/open-file-watches";
import { watchDiffFingerprint } from "../lib/diff-fingerprints";
import { workspaceKey } from "../lib/workspace-key";

type ListFiles = (workspace: FilesWorkspace) => Promise<{ paths: string[] }>;
/** Call `onChange` whenever `workspace`'s files may have changed; returns the unsubscribe. */
type WatchWorkspace = (workspace: FilesWorkspace, onChange: () => void) => () => void;

/**
 * A miss lists again once the listing is this old, for a change the watcher
 * did not report (a workspace it isn't watching, a file it doesn't see).
 */
const MISS_REFRESH_MS = 30_000;
/** After a failed listing, wait this long before the next, doubling up to `MAX_BACKOFF_MS`. */
const FIRST_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

type Entry = {
  /** The latest listing that answered; empty until one has. */
  files: Set<string>;
  /** The workspace's first listing, settled or not: lookups wait for it. */
  first: Promise<void>;
  /** When `files` was last asked for. */
  at: number;
  /** The listing in flight, if any. */
  listing: Promise<void> | null;
  /** The workspace changed since `files` was asked for. */
  stale: boolean;
  /** Failed listings in a row, and when the next may start. */
  failures: number;
  retryAt: number;
};

export function createWorkspaceFileIndex(
  list: ListFiles,
  now: () => number = Date.now,
  watch: WatchWorkspace = () => () => {},
) {
  const entries = new Map<string, Entry>();

  const refresh = (entry: Entry, workspace: FilesWorkspace): Promise<void> => {
    if (entry.listing) return entry.listing;
    entry.stale = false;
    entry.at = now();
    entry.listing = list(workspace)
      .then(
        (result) => {
          entry.files = new Set(result.paths);
          entry.failures = 0;
          entry.retryAt = 0;
        },
        () => {
          // A host that is away keeps the links it last had, and is asked
          // again after a pause, not on every hover.
          entry.failures += 1;
          const backoff = FIRST_BACKOFF_MS * 2 ** (entry.failures - 1);
          entry.retryAt = now() + Math.min(backoff, MAX_BACKOFF_MS);
        },
      )
      .finally(() => {
        entry.listing = null;
      });
    return entry.listing;
  };

  const entryFor = (key: string, workspace: FilesWorkspace): Entry => {
    const existing = entries.get(key);
    if (existing) return existing;
    const entry: Entry = {
      files: new Set(),
      first: Promise.resolve(),
      at: 0,
      listing: null,
      stale: false,
      failures: 0,
      retryAt: 0,
    };
    entries.set(key, entry);
    watch(workspace, () => {
      entry.stale = true;
    });
    entry.first = refresh(entry, workspace);
    return entry;
  };

  return {
    /**
     * The first of `candidates` (workspace-relative paths, most likely first)
     * that is a file in `workspace`, or null for none.
     */
    async find(workspace: FilesWorkspace, candidates: readonly string[]): Promise<string | null> {
      if (candidates.length === 0) return null;
      const entry = entryFor(`${workspace.hostId}\0${workspace.path}`, workspace);
      await entry.first;
      const found = candidates.find((c) => entry.files.has(c)) ?? null;
      const t = now();
      const due = entry.stale || (found === null && t - entry.at >= MISS_REFRESH_MS);
      // Later lookups get the new listing; this one answers now.
      if (due && t >= entry.retryAt) void refresh(entry, workspace);
      return found;
    },
  };
}

/** Marks a workspace's listing stale when the diff watcher sees it change. */
function watchFingerprint(workspace: FilesWorkspace, onChange: () => void): () => void {
  try {
    return watchDiffFingerprint(workspaceKey(workspace.hostId, workspace.path), onChange);
  } catch {
    // A workspace no key can name has no fingerprint; misses still list again.
    return () => {};
  }
}

/** The window's index, over the routed `files.list`. */
export const workspaceFileIndex = createWorkspaceFileIndex(
  (workspace) => window.electronAPI.files.list(workspace),
  Date.now,
  watchFingerprint,
);
