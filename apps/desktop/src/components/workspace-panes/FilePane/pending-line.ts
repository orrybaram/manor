/**
 * A line a file pane should show once its file is open: asked for by a
 * terminal link (`src/foo.ts:12:3`) before the pane, or its file, has loaded.
 * The editor takes it once. It keeps no clock: whoever asked drops it when
 * the open it waits for won't happen (`clearLine`), so a request whose file
 * never opened (the swap bar's Cancel) doesn't jump a later open of it, and
 * a slow swap-bar answer still gets its line.
 */

export type LineRequest = {
  /** Workspace-relative path the line is in. */
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based; the line's start when absent. */
  col?: number;
};

export function createPendingLines() {
  return createPendingRequests<LineRequest>();
}

/** A request per pane that waits for its file to open; lines and comments share it. */
export function createPendingRequests<T extends { path: string }>() {
  const byPane = new Map<string, T>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    /**
     * Show `request.line` in `paneId` once it has `request.path` open (or now,
     * if it has). Replaces the pane's earlier request; returns this one, to
     * tell it apart from a later one in `waiting`.
     */
    request(paneId: string, request: T): T {
      const stored = { ...request };
      byPane.set(paneId, stored);
      for (const listener of listeners.get(paneId) ?? []) listener();
      return stored;
    },
    /** The line waiting for `path` in `paneId`, taken: it is answered once. */
    take(paneId: string, path: string): T | null {
      const pending = byPane.get(paneId);
      if (!pending || pending.path !== path) return null;
      byPane.delete(paneId);
      return { ...pending };
    },
    /** The request waiting in `paneId`, untaken, as `request` returned it. */
    waiting(paneId: string): T | null {
      return byPane.get(paneId) ?? null;
    },
    /** Drop `paneId`'s request: the open it waited for isn't happening. */
    clearLine(paneId: string): void {
      byPane.delete(paneId);
    },
    /** Tell `paneId` a file was sent to it, with or without a line to show. */
    nudge(paneId: string): void {
      for (const listener of listeners.get(paneId) ?? []) listener();
    },
    /** Called on each request or nudge for `paneId`, for an editor that is already open. */
    subscribe(paneId: string, listener: () => void): () => void {
      let set = listeners.get(paneId);
      if (!set) {
        set = new Set();
        listeners.set(paneId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(paneId);
      };
    },
  };
}

export const pendingLines = createPendingLines();
