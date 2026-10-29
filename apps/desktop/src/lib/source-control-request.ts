/**
 * A file pane asked to show Source Control: Open Source Control over a file
 * pane that is already there, or Convert to › Source Control on one. The
 * pane takes the request once — as it mounts, or at once when it is mounted —
 * and opens its drawer on Source Control.
 *
 * A pane made to show Source Control says so on its leaf instead
 * (`PaneNode.startsOn`), so every window and a relaunch agree; this is for a
 * pane whose leaf already exists, and is this window's alone.
 */

const asked = new Set<string>();
const listeners = new Map<string, () => void>();

/** Ask `paneId`'s file pane to show Source Control. */
export function requestSourceControl(paneId: string): void {
  asked.add(paneId);
  listeners.get(paneId)?.();
}

/** Whether `paneId` was asked, taken: it is answered once. */
export function takeSourceControlRequest(paneId: string): boolean {
  return asked.delete(paneId);
}

/** Called on each request for `paneId`, while its file pane is mounted. */
export function onSourceControlRequest(paneId: string, listener: () => void): () => void {
  listeners.set(paneId, listener);
  return () => {
    if (listeners.get(paneId) === listener) listeners.delete(paneId);
  };
}
