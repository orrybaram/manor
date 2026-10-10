/**
 * One-click Copy to / Move to a host (ADR-213). A transfer is either:
 *
 * - **copy**: clone (or adopt) the repo on the target host as a new project
 *   linked to the source (ADR-192); both stay.
 * - **move**: re-point the same project record at a checkout on the target
 *   host (ADR-179).
 *
 * `planTransfer` works out where the project would go without changing
 * anything; `transferProject` runs it. When the plan can't be settled
 * without the user, both return what to ask instead of throwing, so the
 * renderer can open its fallback dialog pre-filled.
 */

import { memberOnHost } from "../../src/lib/project-groups";
import { toDirSlug } from "../branch-name";
import type { ProjectContext } from "./context";
import { planClone, type ClonePlan } from "./host-move";
import { originKey } from "./origin-links";
import { groupOf, resolveShared } from "./project-groups";
import { remoteDirIsCloneOf, remoteDirState, validateRepoUrl } from "./remote-clone";
import type {
  PersistedProject,
  ProjectGroupInfo,
  ProjectInfo,
  TransferInputReason,
  TransferMode,
  TransferPlan,
  TransferResult,
} from "./types";

export type { TransferInputReason, TransferMode, TransferPlan, TransferResult } from "./types";

/**
 * What a transfer needs of `ProjectManager`: its `origin` lookups and the
 * operations it composes, so each keeps its own bookkeeping (the origin
 * cache, `lastKnownWorkspaces`, group origins).
 */
export interface TransferDeps {
  /** `project`'s `origin` key, cached per checkout (`OriginLinks.keyOf`). */
  originKeyOf(project: PersistedProject): Promise<string | null>;
  /** The project's `origin` URL, or null (`ProjectManager.getOriginUrl`). */
  originUrl(projectId: string): Promise<string | null>;
  cloneProject(opts: {
    hostId: string;
    repoUrl: string;
    targetDir: string;
    name: string;
  }): Promise<ProjectInfo>;
  linkProjects(projectId: string, otherId: string): ProjectGroupInfo;
  removeProject(projectId: string): Promise<void>;
  moveProjectToHost(
    projectId: string,
    opts: { hostId: string; repoUrl: string; remoteDir: string },
  ): Promise<ProjectInfo>;
  switchProjectHost(projectId: string, hostId: string, path: string): Promise<ProjectInfo>;
}

type NeedsInput = Extract<TransferPlan, { kind: "needsInput" }>;

function needsInput(
  reason: TransferInputReason,
  repoUrl: string | null,
  targetDir: string,
): NeedsInput {
  return { kind: "needsInput", reason, repoUrl, targetDir };
}

/** The name the sidebar shows for `project`: its group's, or its own. */
function displayName(ctx: ProjectContext, project: PersistedProject): string {
  return resolveShared(groupOf(ctx.store.state, project.id), project).name;
}

/** `~/code/<slug>`, the clone target when nothing better is known. */
function defaultDir(ctx: ProjectContext, project: PersistedProject): string {
  return `~/code/${toDirSlug(displayName(ctx, project)) || "project"}`;
}

/**
 * `project.path` as a `~/…` path when it lives under its host's home
 * (`/Users/me/Code/manor` → `~/Code/manor`), else null. Forward slashes, so
 * a Windows checkout mirrors onto a POSIX host too.
 */
async function mirrorDir(
  ctx: ProjectContext,
  project: PersistedProject,
): Promise<string | null> {
  let home: string;
  try {
    home = await ctx.paths.homeDir(project.hostId);
  } catch {
    // The source host is away; there is nothing to mirror against.
    return null;
  }
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(home);
  const full = norm(project.path);
  if (base === "" || !full.startsWith(`${base}/`)) return null;
  const rel = full.slice(base.length + 1);
  return rel === "" ? null : `~/${rel}`;
}

/**
 * Whether the group `project` is in — or `project` alone — already has a
 * member on `hostId`. The project's own host counts: there is nothing to
 * transfer onto it.
 */
function hostTaken(
  ctx: ProjectContext,
  project: PersistedProject,
  hostId: string,
  mode: TransferMode,
): boolean {
  const group = groupOf(ctx.store.state, project.id);
  const member = memberOnHost(
    group?.memberIds ?? [project.id],
    hostId,
    (id) => ctx.find(id)?.hostId,
  );
  // A move onto the project's own host re-clones its checkout there (the
  // "Repository not found" repair in Project Settings), so it doesn't
  // count as taken by itself.
  return member !== undefined && !(mode === "move" && member === project.id);
}

/** Whether `url` is a remote `git clone` accepts from Manor. */
function isCloneableUrl(url: string): boolean {
  try {
    validateRepoUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `projectId` would go on `hostId`, without changing anything. The
 * target directory is, in order:
 *
 * 1. `remembered`: the path the project last had there, when it still is
 *    a clone of the same repo and no other project owns it;
 * 2. `adopt`: an ungrouped project already on that host with the same
 *    `origin`;
 * 3. `mirror`: the same path under the target's home, when the source
 *    lives under its own;
 * 4. `default`: `~/code/<slug>`.
 *
 * A mirrored or default directory that holds something else, or that
 * another project owns, is `dir-taken` rather than silently replaced by the
 * next choice. Throws for an unknown project or host.
 */
export async function planTransfer(
  ctx: ProjectContext,
  deps: Pick<TransferDeps, "originKeyOf" | "originUrl">,
  projectId: string,
  hostId: string,
  mode: TransferMode = "copy",
): Promise<TransferPlan> {
  ctx.hosts.assertKnown(hostId);
  const project = ctx.find(projectId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);

  const mirrored = await mirrorDir(ctx, project);
  const fallbackDir = mirrored ?? defaultDir(ctx, project);
  const url = await deps.originUrl(projectId);
  if (hostTaken(ctx, project, hostId, mode)) return needsInput("host-taken", url, fallbackDir);
  if (!url || !isCloneableUrl(url)) return needsInput("no-origin", url, fallbackDir);
  const repoUrl = url;
  const host = ctx.host(hostId);

  const remembered = project.hostPaths?.[hostId];
  if (
    remembered &&
    !ctx.findAt(hostId, remembered) &&
    (await host.facts.exists(remembered)) &&
    (await remoteDirIsCloneOf(host, remembered, repoUrl))
  ) {
    return { kind: "ready", repoUrl, targetDir: remembered, via: "remembered" };
  }

  // One `git remote get-url` per project on the host, cached by checkout.
  const key = originKey(repoUrl);
  if (key) {
    const state = ctx.store.state;
    for (const other of state.projects) {
      if (other.id === projectId || other.hostId !== hostId) continue;
      if (groupOf(state, other.id)) continue;
      if ((await deps.originKeyOf(other)) === key) {
        return { kind: "ready", repoUrl, targetDir: other.path, via: "adopt" };
      }
    }
  }

  const candidates: Array<{ dir: string; via: "mirror" | "default" }> = [];
  if (mirrored) candidates.push({ dir: mirrored, via: "mirror" });
  candidates.push({ dir: defaultDir(ctx, project), via: "default" });
  for (const { dir, via } of candidates) {
    let plan: ClonePlan;
    try {
      plan = await planClone(ctx, hostId, { repoUrl, targetDir: dir });
    } catch {
      // A mirrored path the target can't hold (say, a space on a remote
      // host, whose paths are stricter) falls back to the default.
      continue;
    }
    if (plan.owner && plan.owner.id !== projectId) return needsInput("dir-taken", repoUrl, dir);
    const dirState = await remoteDirState(plan.host, plan.targetDir);
    if (dirState === "nonempty" && !(await remoteDirIsCloneOf(plan.host, plan.targetDir, repoUrl))) {
      return needsInput("dir-taken", repoUrl, dir);
    }
    return { kind: "ready", repoUrl, targetDir: dir, via };
  }
  return needsInput("dir-taken", repoUrl, fallbackDir);
}

/**
 * Copy or move `projectId` onto `hostId` (ADR-213). With `overrides` (the
 * fallback dialog's values) planning is skipped and only the safety checks
 * run: the group's room on the host and who owns the directory.
 *
 * - copy: clone (or adopt), then link the new project to the source, so the
 *   group starts from the source's settings. A failed link removes a
 *   project the copy just added rather than leave it unlinked.
 * - move: a `remembered` path switches without cloning; otherwise the
 *   repo is cloned (or adopted) there. An `adopt` plan is `dir-taken`: two
 *   records would claim one checkout, which linking is for.
 *
 * A clone failure throws, with git's message.
 */
export async function transferProject(
  ctx: ProjectContext,
  deps: TransferDeps,
  projectId: string,
  hostId: string,
  mode: TransferMode,
  overrides?: { repoUrl: string; targetDir: string },
): Promise<TransferResult> {
  ctx.hosts.assertKnown(hostId);
  const project = ctx.find(projectId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);
  const ask = (plan: NeedsInput): TransferResult => ({
    ok: false,
    needsInput: { ...plan, mode, hostId },
  });

  let repoUrl: string;
  let targetDir: string;
  let via: Extract<TransferPlan, { kind: "ready" }>["via"] | null = null;
  if (overrides) {
    ({ repoUrl, targetDir } = overrides);
    if (hostTaken(ctx, project, hostId, mode)) {
      return ask(needsInput("host-taken", repoUrl, targetDir));
    }
    const plan = await planClone(ctx, hostId, { repoUrl, targetDir });
    // A copy may adopt an ungrouped project's checkout (it gets linked); a
    // move never takes another project's.
    if (
      plan.owner &&
      plan.owner.id !== projectId &&
      (mode === "move" || groupOf(ctx.store.state, plan.owner.id))
    ) {
      return ask(needsInput("dir-taken", repoUrl, targetDir));
    }
  } else {
    const plan = await planTransfer(ctx, deps, projectId, hostId, mode);
    if (plan.kind === "needsInput") return ask(plan);
    if (mode === "move" && plan.via === "adopt") {
      return ask(needsInput("dir-taken", plan.repoUrl, plan.targetDir));
    }
    ({ repoUrl, targetDir, via } = plan);
  }

  if (mode === "move") {
    const moved =
      via === "remembered"
        ? await deps.switchProjectHost(projectId, hostId, targetDir)
        : await deps.moveProjectToHost(projectId, { hostId, repoUrl, remoteDir: targetDir });
    return { ok: true, project: moved };
  }

  const before = new Set(ctx.store.state.projects.map((p) => p.id));
  const cloned = await deps.cloneProject({
    hostId,
    repoUrl,
    targetDir,
    name: displayName(ctx, project),
  });
  try {
    deps.linkProjects(cloned.id, projectId);
  } catch (err) {
    if (!before.has(cloned.id)) await deps.removeProject(cloned.id);
    throw err;
  }
  const linked = ctx.find(cloned.id);
  return { ok: true, project: linked ? await ctx.info(linked) : cloned };
}
