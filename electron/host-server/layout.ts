/**
 * The layout snapshot a host server serves (ADR-218 D5).
 *
 * In slice 1 the desktop owns layout. It pushes this host's part of it with
 * the manifest (`hostServer.syncLayout`, ticket 4): the layout v3 entries
 * whose workspace key is `<hostId>:<path>` for this host, rekeyed to the bare
 * `<path>`, because to the host server its own host is local. The server
 * caches it in `dataDir/layout.json` and the phone walks it (ADR-181).
 *
 * Read-only here. Ticket 6 adds the synthetic "Started while away" tab for
 * daemon sessions the snapshot lacks, and the named refusal for a device's
 * layout writes.
 */

import fs from "node:fs";
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

function isSnapshot(value: unknown): value is HostLayoutSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === HOST_LAYOUT_VERSION &&
    !!s.workspaces &&
    typeof s.workspaces === "object" &&
    (s.lastActiveWorkspacePath === null ||
      typeof s.lastActiveWorkspacePath === "string")
  );
}

/** The cached snapshot at `file`, or an empty one when there is none. */
export function readLayoutSnapshot(file: string): HostLayoutSnapshot {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (isSnapshot(parsed)) return parsed;
    console.warn(
      `[host-server] ignoring ${file}: not a v${HOST_LAYOUT_VERSION} layout snapshot`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[host-server] could not read ${file}:`, err);
    }
  }
  return emptyLayoutSnapshot();
}
