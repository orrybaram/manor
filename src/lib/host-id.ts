/**
 * The local host id, shared by the renderer and the main process.
 *
 * Kept free of DOM, Node and Electron so `electron/` can import it (its
 * typecheck has no DOM types). Mirrors `LOCAL_HOST_ID` in
 * `electron/backend/types.ts`, which the terminal-host side imports; a test
 * in `electron/projects/workspace-key.test.ts` pins the two together.
 */

/** The host every project without a `hostId` lives on: this machine. */
export const LOCAL_HOST_ID = "local";

/** `hostId`, with a missing or empty one read as `LOCAL_HOST_ID`. */
export function normalizeHostId(hostId: string | null | undefined): string {
  return hostId || LOCAL_HOST_ID;
}
