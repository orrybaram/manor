/**
 * The project list, addressed by `WorkspaceKey` (ADR-204).
 *
 * A workspace is *(host, path)* (ADR-191): a local and a remote project of
 * the same repo, under the same username, list byte-identical workspace
 * paths. Every "which workspace is this" question goes through here, by key,
 * so one host's branch, PR or diff stats can't land on the other's workspace.
 *
 * - `keyOf` builds a workspace's key from its project;
 * - `find` / `ownerOf` look a key up;
 * - `patch` updates the workspace a key names, on that host only;
 * - `reconcile` carries watcher state over a project reload, by key;
 * - `hostForPath` is the one path-only fallback, for callers that are handed
 *   a bare path and nothing else.
 *
 * Pure: data in, data out, no store and no `window`. Generic over a minimal
 * project shape so tests can use plain literals. Nothing is cached: lookups
 * scan (projects × workspaces is small), so there is no index to go stale.
 */

import { isHomePath } from "./home-path";
import { branchesEqual } from "../utils/branch-name";
import {
  LOCAL_HOST_ID,
  normalizeHostId,
  parseWorkspaceKey,
  workspaceKey,
  type HostId,
  type WorkspaceKey,
} from "./workspace-key";

/** What the directory needs to know about a workspace: where it is. */
interface DirectoryWorkspace {
  path: string;
}

/**
 * What the directory needs to know about a project. `ProjectInfo` fits as
 * is. A missing `hostId` means local, as on disk (ADR-160).
 */
export interface DirectoryProject<W extends DirectoryWorkspace = DirectoryWorkspace> {
  id?: string;
  path: string;
  hostId?: HostId | null;
  workspaces: readonly W[];
}

/** The workspace type a project lists. */
type WorkspaceOf<P extends DirectoryProject> = P["workspaces"][number];

/** The project list and which project is selected, as the project store has them. */
export interface ProjectSelection<P extends DirectoryProject = DirectoryProject> {
  projects: readonly P[];
  selectedProjectIndex: number;
}

/** A workspace `find` located: its project, itself, and its index in the project's list. */
interface Found<P extends DirectoryProject> {
  project: P;
  workspace: WorkspaceOf<P>;
  index: number;
}

/** Whether `project` is on `hostId` (already normalized). */
function isOnHost(project: DirectoryProject, hostId: HostId): boolean {
  return normalizeHostId(project.hostId) === hostId;
}

/** Whether `project` has `path`: its main checkout or one of its workspaces. */
function hasPath(project: DirectoryProject, path: string): boolean {
  return project.path === path || project.workspaces.some((w) => w.path === path);
}

/** The key of `workspace`, one of `project`'s: its path on the project's host. */
export function keyOf(
  project: Pick<DirectoryProject, "hostId">,
  workspace: DirectoryWorkspace,
): WorkspaceKey {
  return workspaceKey(project.hostId, workspace.path);
}

/**
 * The workspace keyed `key`: the first project on the key's host that lists
 * the key's path among its workspaces. Undefined when none does. Unlike
 * `ownerOf`, a project's main checkout path counts only when it is listed.
 */
export function find<P extends DirectoryProject>(
  projects: readonly P[],
  key: WorkspaceKey,
): Found<P> | undefined {
  const { hostId, path } = parseWorkspaceKey(key);
  for (const project of projects) {
    if (!isOnHost(project, hostId)) continue;
    const index = project.workspaces.findIndex((w) => w.path === path);
    if (index >= 0) return { project, workspace: project.workspaces[index], index };
  }
  return undefined;
}

/**
 * The project that has the workspace keyed `key`: on the key's host, with
 * the key's path as its main checkout or one of its workspaces. Undefined
 * for no key, for Home, and for a path no project on that host has.
 *
 * Takes a plain string so a key read back from storage can be passed as is;
 * a bare path parses as local.
 */
export function ownerOf<P extends DirectoryProject>(
  projects: readonly P[],
  key: string | null | undefined,
): P | undefined {
  if (!key) return undefined;
  const { hostId, path } = parseWorkspaceKey(key);
  return projects.find((p) => isOnHost(p, hostId) && hasPath(p, path));
}

/**
 * `projects` with `fn` applied to the workspace keyed `key`, in every project
 * on the key's host that lists it. Projects on other hosts are left alone,
 * even when they list the same path.
 *
 * When `fn` returns the workspace it was given for every match (or nothing
 * matches), the same `projects` array comes back, so a store `set` with it
 * wakes no subscriber. Put the "did anything change" check inside `fn`.
 */
export function patch<P extends DirectoryProject>(
  projects: P[],
  key: WorkspaceKey,
  fn: (workspace: WorkspaceOf<P>) => WorkspaceOf<P>,
): P[] {
  const { hostId, path } = parseWorkspaceKey(key);
  let changed = false;
  const next = projects.map((project) => {
    if (!isOnHost(project, hostId)) return project;
    let touched = false;
    const workspaces = project.workspaces.map((ws: WorkspaceOf<P>) => {
      if (ws.path !== path) return ws;
      const patched = fn(ws);
      if (patched !== ws) touched = true;
      return patched;
    });
    if (!touched) return project;
    changed = true;
    return { ...project, workspaces };
  });
  return changed ? next : projects;
}

/** A workspace the watchers fill in: its branch, and the PR and diff stats found for it. */
interface WatchedWorkspace extends DirectoryWorkspace {
  branch?: string | null;
  pr?: unknown;
  diffStats?: unknown;
}

/**
 * `fresh`, a newly loaded project list, with the `pr` and `diffStats` the
 * watchers had filled into `previous` carried over, so a reload doesn't blank
 * them until the next poll. A workspace keeps them only from the workspace
 * with the same key *and* the same branch (`branchesEqual`): a PR found for
 * one host's workspace, or for a branch since switched away from, stays
 * behind. Values `fresh` already has win.
 */
export function reconcile<P extends DirectoryProject<WatchedWorkspace>>(
  fresh: readonly P[],
  previous: readonly P[],
): P[] {
  const byKey = new Map<WorkspaceKey, WorkspaceOf<P>>();
  for (const project of previous) {
    for (const ws of project.workspaces) byKey.set(keyOf(project, ws), ws);
  }
  return fresh.map((project) => ({
    ...project,
    workspaces: project.workspaces.map((ws: WorkspaceOf<P>) => {
      const prev = byKey.get(keyOf(project, ws));
      if (!prev || !branchesEqual(prev.branch, ws.branch)) return ws;
      return {
        ...ws,
        pr: ws.pr ?? prev.pr,
        diffStats: ws.diffStats ?? prev.diffStats,
      };
    }),
  }));
}

/**
 * The host of the workspace at `path`, for a caller that has only the path:
 * the host of the project that has it (main checkout or workspace), the
 * selected project first when two share the path, since that is the one the
 * user opened. Home is on this machine. Undefined when no project has the
 * path, so main falls back to the host the path belongs to.
 *
 * A path-only guess, and the only one left: a caller that knows the host
 * (an active workspace, a pane's key, a port's `hostId`) should build a key
 * and use `ownerOf` / `find` instead. Remaining callers are the
 * control-server commands whose `hostId` is optional (ADR-204 §4).
 */
export function hostForPath(
  selection: ProjectSelection,
  path: string | null | undefined,
): HostId | undefined {
  if (isHomePath(path)) return LOCAL_HOST_ID;
  if (!path) return undefined;
  const selected = selection.projects[selection.selectedProjectIndex];
  const owner =
    selected && hasPath(selected, path)
      ? selected
      : selection.projects.find((p) => hasPath(p, path));
  return owner ? normalizeHostId(owner.hostId) : undefined;
}
