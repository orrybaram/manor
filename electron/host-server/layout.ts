/**
 * The layout snapshot a host server serves (ADR-218 D5).
 *
 * In slice 1 the desktop owns layout. It pushes this host's part of it with
 * the manifest (`hostServer.syncLayout`, `./owner.ts`): the layout v3 entries
 * whose workspace key is `<hostId>:<path>` for this host, rekeyed to the bare
 * `<path>`, because to the host server its own host is local. The server
 * caches it in `dataDir/layout.json` (`./owner-snapshot.ts`) and the phone
 * walks it (ADR-181).
 *
 * Read-only here. Ticket 6 adds the synthetic "Started while away" tab for
 * daemon sessions the snapshot lacks, and the named refusal for a device's
 * layout writes.
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

export function emptyLayoutSnapshot(): HostLayoutSnapshot {
  return {
    version: HOST_LAYOUT_VERSION,
    takenAt: new Date(0).toISOString(),
    workspaces: {},
    lastActiveWorkspacePath: null,
  };
}
