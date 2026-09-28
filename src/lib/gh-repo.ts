/**
 * A checkout `gh` works on, named by host as well as path (ADR-191): a local
 * and a remote checkout can share a path, and guessing the host from the
 * path picks local. Shared by the main process and the renderer.
 */

import { normalizeHostId, type HostId } from "./host-id";

export interface GhRepo {
  path: string;
  hostId: HostId;
}

/** The checkout of `project`'s root, on the project's host. */
export function ghRepoOf(project: { path: string; hostId?: HostId | null }): GhRepo {
  return { path: project.path, hostId: normalizeHostId(project.hostId) };
}
