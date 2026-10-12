/**
 * The manifest: what the desktop tells a host server about the projects on
 * its host (ADR-218 D2, D4, D8).
 *
 * In slice 1 the desktop owns projects. It pushes this over the owner channel
 * on connect and on change (`hostServer.syncManifest`, `./owner.ts`), and the
 * host server caches it in `dataDir/manifest.json`, so a phone that connects
 * with the lid closed still sees the sidebar it would have seen.
 *
 * - **Projects** are the desktop's `projects.json` records for this host —
 *   names, workspace names and linked issues, folders, order, colour and the
 *   rest of the display settings — with `hostId` rewritten to `local`,
 *   because to the host server its own host is local. A grouped project's
 *   shared settings (ADR-192) arrive already resolved; the host server knows
 *   nothing of groups.
 * - **The integration snapshot** is the issue and PR data the desktop
 *   already had for each workspace, stamped with when it was taken (D8). The
 *   host server makes no integration calls in slice 1, so this is the only
 *   way that data reaches a phone with the lid closed, and `takenAt` is how
 *   the phone says how old it is.
 *
 * Which worktrees exist is not in it: git on the box is the authority, and
 * the `projects` reads list them (`listGitWorkspaces`).
 */

import fs from "node:fs";
import type { GitBackend } from "../backend/types";
import { LOCAL_HOST_ID } from "../backend/types";
import { buildProjectInfo } from "../projects/project-info";
import type {
  LinkedIssue,
  PersistedProject,
  ProjectInfo,
} from "../projects/types";
import type { PrInfo } from "../../src/lib/pr-info";

/** Bumped when a manifest's shape changes in a way a reader must notice. */
export const HOST_MANIFEST_VERSION = 1;

/** A project on this host, as the desktop persists it, re-homed to `local`. */
export type ManifestProject = Omit<PersistedProject, "hostId" | "hostPaths"> & {
  hostId: typeof LOCAL_HOST_ID;
};

/** A workspace's linked issue, as the sidebar shows it. */
export type IssueSnapshot = Pick<LinkedIssue, "id" | "title" | "url"> &
  Partial<Pick<LinkedIssue, "identifier">>;

/** A workspace's PR, as the sidebar badge shows it. */
export type PrSnapshot = Pick<PrInfo, "number" | "state" | "title" | "url"> &
  Partial<Pick<PrInfo, "isDraft" | "checks">>;

/** What the desktop knew about one workspace's issue and PR (ADR-218 D8). */
export interface WorkspaceIntegrationSnapshot {
  /** ISO time the desktop took this. The phone shows its age. */
  takenAt: string;
  issue: IssueSnapshot | null;
  pr: PrSnapshot | null;
}

export interface HostManifest {
  version: typeof HOST_MANIFEST_VERSION;
  /** ISO time the desktop sent it. */
  sentAt: string;
  /**
   * The desktop's name for this host (its hosts record). The phone's
   * pairings show it; absent, the server names itself by `os.hostname()`.
   */
  hostName?: string;
  projects: ManifestProject[];
  /** Workspace path → its last-known issue and PR. */
  integrationSnapshot: Record<string, WorkspaceIntegrationSnapshot>;
}

/** The manifest a server has before the desktop ever sent one. */
export function emptyManifest(): HostManifest {
  return {
    version: HOST_MANIFEST_VERSION,
    sentAt: new Date(0).toISOString(),
    projects: [],
    integrationSnapshot: {},
  };
}

function isManifest(value: unknown): value is HostManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    m.version === HOST_MANIFEST_VERSION &&
    Array.isArray(m.projects) &&
    !!m.integrationSnapshot &&
    typeof m.integrationSnapshot === "object"
  );
}

/**
 * The cached manifest at `file`, or an empty one when there is none yet —
 * or one this version cannot read, which the desktop replaces on its next
 * connect.
 */
export function readManifest(file: string): HostManifest {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (isManifest(parsed)) return parsed;
    console.warn(
      `[host-server] ignoring ${file}: not a v${HOST_MANIFEST_VERSION} manifest`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[host-server] could not read ${file}:`, err);
    }
  }
  return emptyManifest();
}

/** The host server routes nothing by path: every path is this host's. */
const NO_ROUTING = { setWorkspacePaths: () => {} };

/**
 * What `projects.getAll` answers on a host server: each manifest project
 * built exactly as the desktop builds it (`buildProjectInfo`), over the
 * worktrees git lists on this box.
 */
export function manifestProjects(
  manifest: HostManifest,
  git: GitBackend,
): Promise<ProjectInfo[]> {
  return Promise.all(
    manifest.projects.map((p) =>
      buildProjectInfo({ ...p, hostId: LOCAL_HOST_ID }, git, NO_ROUTING),
    ),
  );
}
