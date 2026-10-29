/**
 * Which files a workspace has, for the terminal's path links: one
 * `files.list` per workspace, kept for a while, rather than a read per hover.
 */

import type { FilesWorkspace } from "../components/workspace-panes/FilePane/open-file-watches";

type ListFiles = (workspace: FilesWorkspace) => Promise<{ paths: string[] }>;

/** A listing this old is listed again before it answers. */
const MAX_AGE_MS = 30_000;
/**
 * A path the listing does not have lists again, once the listing is this old:
 * a file an agent just wrote becomes a link without waiting out `MAX_AGE_MS`,
 * and a line of misses does not list once per miss.
 */
const MISS_REFRESH_MS = 3_000;

type Entry = { files: Promise<Set<string>>; at: number };

export function createWorkspaceFileIndex(list: ListFiles, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();

  const refresh = (key: string, workspace: FilesWorkspace): Entry => {
    const entry: Entry = {
      at: now(),
      files: list(workspace).then(
        (result) => new Set(result.paths),
        () => {
          // A host that is away has no links; ask again next time.
          if (entries.get(key) === entry) entries.delete(key);
          return new Set<string>();
        },
      ),
    };
    entries.set(key, entry);
    return entry;
  };

  return {
    /**
     * The first of `candidates` (workspace-relative paths, most likely first)
     * that is a file in `workspace`, or null for none.
     */
    async find(workspace: FilesWorkspace, candidates: readonly string[]): Promise<string | null> {
      if (candidates.length === 0) return null;
      const key = `${workspace.hostId}\0${workspace.path}`;
      let entry = entries.get(key);
      if (!entry || now() - entry.at > MAX_AGE_MS) entry = refresh(key, workspace);
      const pick = (files: Set<string>) => candidates.find((c) => files.has(c)) ?? null;
      const found = pick(await entry.files);
      if (found !== null) return found;
      const latest = entries.get(key) ?? entry;
      if (latest !== entry) return pick(await latest.files);
      if (now() - entry.at < MISS_REFRESH_MS) return null;
      return pick(await refresh(key, workspace).files);
    },
  };
}

/** The window's index, over the routed `files.list`. */
export const workspaceFileIndex = createWorkspaceFileIndex((workspace) =>
  window.electronAPI.files.list(workspace),
);
