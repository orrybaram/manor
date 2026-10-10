/**
 * Moving a project between hosts (ADR-179): cloning it onto a remote host,
 * or switching it to a path it already has on another host, while keeping
 * the same project record (ADR-183 split this out of `ProjectManager`).
 */

import { LOCAL_HOST_ID } from "../backend/types";
import { detectDefaultBranch } from "./branches";
import type { ProjectContext } from "./context";
import { emitCloneProgress } from "./progress";
import { assertGroupHostFree } from "./project-groups";
import {
  prepareRemoteClone,
  resolveCloneDir,
  validateRepoUrl,
} from "./remote-clone";
import type { PersistedProject, ProjectHost, ProjectInfo } from "./types";

/**
 * Move `record[from]` to `record[to]` (overwriting), leaving it unchanged
 * when `record` is absent or has no `from` entry.
 */
export function rekeyRecord<T>(
  record: Record<string, T> | undefined,
  from: string,
  to: string,
): void {
  if (!record || !Object.prototype.hasOwnProperty.call(record, from)) return;
  record[to] = record[from];
  delete record[from];
}

/** Where a clone onto a host goes, resolved before anything is cloned. */
export interface ClonePlan {
  host: ProjectHost;
  repoUrl: string;
  targetDir: string;
  /** The project that already lives at `targetDir` on that host, if any. */
  owner: PersistedProject | undefined;
}

/**
 * Validate a clone request and resolve its target, expanding `~` against
 * the host's home, so the owner check runs without touching the host's
 * filesystem. `hostId` must already be known.
 */
export async function planClone(
  ctx: ProjectContext,
  hostId: string,
  opts: { repoUrl: string; targetDir: string },
): Promise<ClonePlan> {
  const repoUrl = opts.repoUrl.trim();
  validateRepoUrl(repoUrl);
  const host = ctx.host(hostId);
  const targetDir = await resolveCloneDir(
    hostId === LOCAL_HOST_ID,
    opts.targetDir,
    () => ctx.paths.homeDir(hostId),
    host.facts.join,
  );
  return { host, repoUrl, targetDir, owner: ctx.findAt(hostId, targetDir) };
}

/** Clone (or adopt) per `plan`, with progress on `projects:clone-progress`. */
export function runClone(plan: ClonePlan): Promise<void> {
  return prepareRemoteClone(plan.host, plan.repoUrl, plan.targetDir, emitCloneProgress);
}

/**
 * Move an existing project onto another host — remote or, since ADR-213,
 * this machine — by cloning (or adopting) its repo there, keeping the same
 * project record (ADR-179): id, name, colour,
 * commands, agent settings and Linear associations all survive. The main
 * workspace's per-path settings follow it to the new path; an absolute
 * worktree root from the old machine is dropped.
 */
export async function moveProjectToHost(
  ctx: ProjectContext,
  projectId: string,
  opts: { hostId: string; repoUrl: string; remoteDir: string },
): Promise<ProjectInfo> {
  const { hostId } = opts;
  ctx.hosts.assertKnown(hostId);
  const project = ctx.find(projectId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);
  assertGroupHostFree(ctx, projectId, hostId);

  const plan = await planClone(ctx, hostId, {
    repoUrl: opts.repoUrl,
    targetDir: opts.remoteDir,
  });
  if (plan.owner && plan.owner.id !== projectId) {
    throw new Error(
      `"${plan.targetDir}" on this host already belongs to project "${plan.owner.name}".`,
    );
  }

  await runClone(plan);
  await repointProject(ctx, project, hostId, plan.targetDir);
  ctx.store.save();
  return ctx.info(project);
}

/**
 * Switch a project to `hostId` without cloning (ADR-179): to `path` when
 * given, else the path it last had on that host, else its current path.
 * Throws when that path does not exist on the host, so a switch can never
 * leave a project whose terminals can't `chdir`. The caller connects a
 * remote host first.
 */
export async function switchProjectHost(
  ctx: ProjectContext,
  projectId: string,
  hostId: string,
  explicitPath?: string,
): Promise<ProjectInfo> {
  ctx.hosts.assertKnown(hostId);
  const project = ctx.find(projectId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);
  const targetPath = explicitPath ?? project.hostPaths?.[hostId] ?? project.path;
  if (hostId === project.hostId && targetPath === project.path) {
    return ctx.info(project);
  }
  assertGroupHostFree(ctx, projectId, hostId);
  const label = ctx.hosts.label(hostId);
  if (!(await ctx.host(hostId).facts.exists(targetPath))) {
    throw new Error(`Project path "${targetPath}" does not exist on ${label}.`);
  }
  const owner = ctx.findAt(hostId, targetPath);
  if (owner && owner.id !== projectId) {
    throw new Error(
      `"${targetPath}" on ${label} already belongs to project "${owner.name}".`,
    );
  }
  await repointProject(ctx, project, hostId, targetPath);
  ctx.store.save();
  return ctx.info(project);
}

/**
 * Point `project` at `newPath` on `hostId`, remembering the path it is
 * leaving in `hostPaths` and carrying the main workspace's per-path
 * settings over to the new path. Does not save.
 */
export async function repointProject(
  ctx: ProjectContext,
  project: PersistedProject,
  hostId: string,
  newPath: string,
): Promise<void> {
  const oldHostId = project.hostId;
  const oldPath = project.path;

  const detected = await detectDefaultBranch(ctx.host(hostId).git, newPath);
  project.hostPaths = { ...project.hostPaths, [oldHostId]: oldPath };
  project.path = newPath;
  project.hostId = hostId;
  if (detected) project.defaultBranch = detected;

  if (oldPath !== newPath) {
    rekeyRecord(project.workspaceNames, oldPath, newPath);
    rekeyRecord(project.workspaceIssues, oldPath, newPath);
    rekeyRecord(project.workspaceHidden, oldPath, newPath);
    rekeyRecord(project.workspaceFolderIds, oldPath, newPath);
    if (project.workspaceOrder) {
      project.workspaceOrder = project.workspaceOrder.map((key) =>
        key === oldPath ? newPath : key,
      );
    }
  }
  // An absolute worktree root names a directory on the old machine; null
  // falls back to the new host's default. A `~` root is stored unexpanded
  // (ADR-183), so it means the new host's home and is kept.
  if (
    oldHostId !== hostId &&
    project.worktreePath &&
    !project.worktreePath.startsWith("~")
  ) {
    project.worktreePath = null;
  }
  // Workspace paths from the old host would otherwise route
  // `hostIdForPath` until the next `buildProjectInfo` replaces them.
  ctx.paths.forgetWorkspacePaths(project.id);
}
