/**
 * A host's part of the desktop's layout, as the desktop hands it to that
 * host's server (ADR-227 D3).
 *
 * The host server owns its layout (ADR-227 D2): a real `LayoutStore`,
 * persisted to `dataDir/layout.json` (`hostServerPaths().layout`) and keyed
 * by bare workspace paths, because to the host server its own host is
 * local. Before the flip that layout lived in the desktop's `layout.json`,
 * under `<hostId>:<path>` keys; adoption (`hostServer.adopt`, `./adopt.ts`)
 * moves it onto the box in this shape — rekeyed to the bare path, window
 * claims cleared (`hostLayoutSnapshot` in `../backend/host-server-sync.ts`).
 */

import type { LayoutEntry } from "../../src/lib/layout/protocol";

/** Bumped when the snapshot's shape changes in a way a reader must notice. */
export const HOST_LAYOUT_VERSION = 1;

export interface HostLayoutSnapshot {
  version: typeof HOST_LAYOUT_VERSION;
  /** ISO time the desktop took it. */
  takenAt: string;
  /** Bare workspace path → its layout, as `layout.getAll` answers. */
  workspaces: Record<string, LayoutEntry>;
  /** The workspace the desktop last showed, if it is on this host. */
  lastActiveWorkspacePath: string | null;
}
