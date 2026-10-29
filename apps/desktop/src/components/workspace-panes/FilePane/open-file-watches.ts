/** A workspace as the files API names it. */
export type FilesWorkspace = { path: string; hostId: string };

type Watch = (workspace: FilesWorkspace, relPaths: string[]) => Promise<void> | void;

/**
 * This renderer's open files, by pane. `files.watch` replaces the caller's
 * whole watch set for a workspace, and the caller is the window, not the
 * pane: two file panes of one workspace would each unwatch the other's file.
 * So every pane says what it has open here, and the window's union for that
 * workspace is what goes out.
 */
export function createOpenFileWatches(watch: Watch) {
  const byWorkspace = new Map<
    string,
    { workspace: FilesWorkspace; byPane: Map<string, string> }
  >();

  return {
    /** `paneId` has `relPath` open in `workspace`; null for nothing. */
    set(workspace: FilesWorkspace, paneId: string, relPath: string | null): void {
      const key = `${workspace.hostId}\0${workspace.path}`;
      let entry = byWorkspace.get(key);
      if (!entry) {
        if (relPath === null) return;
        entry = { workspace, byPane: new Map() };
        byWorkspace.set(key, entry);
      }
      if (relPath === null) {
        if (!entry.byPane.delete(paneId)) return;
      } else {
        if (entry.byPane.get(paneId) === relPath) return;
        entry.byPane.set(paneId, relPath);
      }
      const paths = [...new Set(entry.byPane.values())].sort();
      if (paths.length === 0) byWorkspace.delete(key);
      void Promise.resolve(watch(workspace, paths)).catch(() => {
        // A host that is away watches nothing; the next open file asks again.
      });
    },
  };
}

export const openFileWatches = createOpenFileWatches((workspace, relPaths) =>
  window.electronAPI.files.watch(workspace, relPaths),
);
