/**
 * A project record as the desktop hands it to a host server (ADR-227 D3).
 *
 * The host server owns its projects (ADR-227 D2): they live in its own
 * `projects.json`, every one `hostId: "local"`, because to the host server
 * its own host is local. Before the flip they lived in the desktop's
 * `projects.json`; adoption (`hostServer.adopt`, ticket 6) moves them onto
 * the box as these — the desktop's records for this host, `hostPaths`
 * dropped and a grouped project's shared settings (ADR-192) already
 * resolved, since the host server knows nothing of groups
 * (`ProjectManager.manifestRecords`).
 */

import type { LOCAL_HOST_ID } from "../backend/types";
import type { PersistedProject } from "../projects/types";

/** A project on this host, as the desktop persists it, re-homed to `local`. */
export type ManifestProject = Omit<PersistedProject, "hostId" | "hostPaths"> & {
  hostId: typeof LOCAL_HOST_ID;
};
