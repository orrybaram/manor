/**
 * A line a file pane should show once its file is open: asked for by a
 * terminal link (`src/foo.ts:12:3`) before the pane, or its file, has loaded.
 * Transient: the editor takes it once, and an old one is ignored, so a
 * request whose file never opened (the swap bar's Cancel) doesn't jump a
 * later open of it.
 */

export type LineRequest = {
  /** Workspace-relative path the line is in. */
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based; the line's start when absent. */
  col?: number;
};

/** A request this old has missed its open. */
const MAX_AGE_MS = 30_000;

export function createPendingLines(now: () => number = Date.now) {
  const byPane = new Map<string, LineRequest & { at: number }>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    /** Show `request.line` in `paneId` once it has `request.path` open (or now, if it has). */
    request(paneId: string, request: LineRequest): void {
      byPane.set(paneId, { ...request, at: now() });
      for (const listener of listeners.get(paneId) ?? []) listener();
    },
    /** The line waiting for `path` in `paneId`, taken: it is answered once. */
    take(paneId: string, path: string): LineRequest | null {
      const pending = byPane.get(paneId);
      if (!pending || pending.path !== path) return null;
      byPane.delete(paneId);
      if (now() - pending.at > MAX_AGE_MS) return null;
      const { at: _at, ...request } = pending;
      return request;
    },
    /** Called on each request for `paneId`, for an editor that is already open. */
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
