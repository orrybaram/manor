import { useCallback, useSyncExternalStore } from "react";
import type { FileAuthor } from "../../../electron.d";
import { watchDiffFingerprint } from "../../../lib/diff-fingerprints";
import { workspaceKey, type WorkspaceKey } from "../../../lib/workspace-key";
import { fetchDiffSingleFlight, localDiffKey } from "../DiffPane/diff-fetch";
import { fileChangesFromDiff, type FileChange } from "./file-changes";
import type { FilesWorkspace } from "./open-file-watches";

/** A workspace's changes as the file pane shows them. */
export type WorkspaceChanges = {
  /** Changed files vs. HEAD (the diff pane's Local view), by workspace-relative path. */
  files: ReadonlyMap<string, FileChange>;
  /**
   * The agent that last wrote each file, where its hooks said and nothing
   * has written the file since.
   */
  authors: Readonly<Record<string, FileAuthor>>;
};

type Entry = {
  refs: number;
  value: WorkspaceChanges | null;
  /** What `value` was read from, so an unchanged re-fetch tells nobody. */
  raw: string | null;
  authorsJson: string;
  listeners: Set<() => void>;
  stop: () => void;
};

const entries = new Map<WorkspaceKey, Entry>();

/**
 * Follow `workspace`'s changes: fetched when the first file pane on it
 * subscribes, then again only when the diff watcher's fingerprint for it
 * moves (`watchDiffFingerprint`), as an open diff pane does. No timer and no
 * git of its own: the diff is the diff pane's local fetch. Every file pane
 * of a workspace shares one entry; the last to leave stops it.
 */
function subscribe(workspace: FilesWorkspace, listener: () => void): () => void {
  const key = workspaceKey(workspace.hostId, workspace.path);
  let entry = entries.get(key);
  if (!entry) {
    entry = start(key, workspace.path);
    entries.set(key, entry);
  }
  entry.refs++;
  entry.listeners.add(listener);
  const held = entry;
  return () => {
    held.listeners.delete(listener);
    held.refs--;
    if (held.refs === 0) {
      held.stop();
      if (entries.get(key) === held) entries.delete(key);
    }
  };
}

function start(key: WorkspaceKey, path: string): Entry {
  let live = true;
  const entry: Entry = {
    refs: 0,
    value: null,
    raw: null,
    authorsJson: "",
    listeners: new Set(),
    stop: () => {
      live = false;
      unwatch();
    },
  };
  // Runs answer out of order (a slow authors request); a run older than the
  // one shown is dropped.
  let started = 0;
  let shown = 0;
  const run = () => {
    const seq = ++started;
    // The diff pane's own Local fetch: one `git diff` for both when they ask together.
    const diff = fetchDiffSingleFlight(localDiffKey(key), () =>
      window.electronAPI.diffs.getLocalDiff(path),
    );
    // Attribution is a nicety: a server too old to answer leaves files unclaimed.
    const authors = Promise.resolve()
      .then(() => window.electronAPI.agents.getFileAuthors(key))
      .catch(() => ({}) as Record<string, FileAuthor>);
    Promise.all([diff, authors]).then(
      ([raw, byPath]) => {
        if (!live || seq < shown) return;
        shown = seq;
        const authorsJson = JSON.stringify(byPath);
        if (entry.value && raw === entry.raw && authorsJson === entry.authorsJson) return;
        entry.raw = raw;
        entry.authorsJson = authorsJson;
        // Diff paths are the repo root's; a workspace in a repo's subfolder is not handled.
        entry.value = { files: fileChangesFromDiff(raw), authors: byPath };
        for (const listener of entry.listeners) listener();
      },
      () => {
        // A failed diff keeps what was shown; the next fingerprint retries.
      },
    );
  };
  const unwatch = watchDiffFingerprint(key, run);
  run();
  return entry;
}

function snapshot(workspace: FilesWorkspace | null): WorkspaceChanges | null {
  if (!workspace) return null;
  return entries.get(workspaceKey(workspace.hostId, workspace.path))?.value ?? null;
}

/** `workspace`'s changes, null until first fetched (and for no workspace). */
export function useWorkspaceChanges(workspace: FilesWorkspace | null): WorkspaceChanges | null {
  const hostId = workspace?.hostId;
  const path = workspace?.path;
  const sub = useCallback(
    (listener: () => void) =>
      hostId !== undefined && path !== undefined
        ? subscribe({ hostId, path }, listener)
        : () => {},
    [hostId, path],
  );
  return useSyncExternalStore(sub, () =>
    hostId !== undefined && path !== undefined ? snapshot({ hostId, path }) : null,
  );
}

/**
 * Follow `workspace`'s changes outside React (the editor's gutter): `onChange`
 * hears each new value. Returns the unsubscribe.
 */
export function followWorkspaceChanges(
  workspace: FilesWorkspace,
  onChange: (changes: WorkspaceChanges) => void,
): () => void {
  const notify = () => {
    const value = snapshot(workspace);
    if (value) onChange(value);
  };
  const stop = subscribe(workspace, notify);
  notify();
  return stop;
}
