/**
 * Move a workspace to another host: a recreate, not a live transfer.
 *
 * `preflightWorkspaceMove` reads the source workspace and the target host
 * and says what a move would do, and what refuses it. It changes nothing.
 * `moveWorkspaceToHost` runs it, in order:
 *
 * 1. **push** the branch to `origin` (setting the upstream when there is none),
 * 2. **setUp** the project on the target with the transfer's copy when the
 *    target has no member of the project's group (`transferProject`; a
 *    `needsInput` comes back as it is),
 * 3. **create** the workspace on the target on the same branch, with the
 *    same name, linked issues and folder, then **setupScript**: the
 *    project's worktree start script, waited for. A workspace the target
 *    already has on the branch is reused instead, fast-forwarded only,
 * 4. **restore** and **agents**: whatever the injected `WorkspaceRecreator`
 *    plans (the layout and the agents; nothing by default),
 * 5. **removeSource** through the normal removal path, keeping the branch,
 *    unless `keepSource`.
 *
 * A failure at any step stops there: the source is removed only once every
 * step before it succeeded, so a failed move leaves it as it was.
 *
 * Runs in the desktop's Manor server, so the CLI and MCP can use it as the
 * UI does. Each host is reached the way `host-transfer.ts` reaches it:
 * git through that host's backend, whatever the host; workspace writes
 * through `WorkspaceOps` for a project this desktop holds, and through the
 * host's server for one on an adopted host (`createWorkspaceHostMoveDeps`).
 */

import type { BackendRegistry } from "../backend/registry";
import { LOCAL_HOST_ID, type GitBackend } from "../backend/types";
import { errorMessage } from "../lib/errors";
import type { HostRouting } from "../server/host-routing";
import type { SetupScriptEnd, WorkspaceOps } from "../workspace-ops";
import type { ProjectManager } from "./project-manager";
import type {
  CreateWorktreeOptions,
  LinkedIssue,
  ProjectInfo,
  TransferResult,
  WorkspaceFolder,
  WorkspaceInfo,
} from "./types";
import { branchesEqual } from "../../src/utils/branch-name";
import { workspaceKey, type WorkspaceKey } from "../../src/lib/workspace-key";

// ── Types ──

/** One changed file in a workspace, as `git status --porcelain` lists it. */
export interface DirtyFile {
  /** The two-letter porcelain code: ` M`, `??`, `R `… */
  code: string;
  path: string;
}

/** Why a move is refused. A refused move touches nothing. */
export type WorkspaceMoveRefusal =
  | { code: "dirty"; files: DirtyFile[] }
  | { code: "no-origin" }
  | { code: "main-workspace" }
  | { code: "same-host" }
  | { code: "detached" }
  | { code: "target-dirty"; files: DirtyFile[] }
  | { code: "target-cannot-fast-forward" };

/** The workspace the target already has on the branch. */
export interface ExistingTargetWorkspace {
  path: string;
  dirty: boolean;
  /** Whether the source's branch head contains the target's: an ff-only update. */
  canFastForward: boolean;
}

export interface WorkspaceMovePreflight {
  sourceHostId: string;
  /** The source's branch; its short SHA for a detached HEAD. */
  branch: string;
  /** The workspace's name: its own, else its branch. */
  name: string;
  isMain: boolean;
  hasOrigin: boolean;
  dirtyFiles: DirtyFile[];
  /** Commits `origin` does not have yet, when they could be counted. */
  aheadCount?: number;
  /** Whether the push step runs: the branch has commits `origin` lacks, or no upstream. */
  needsPush: boolean;
  /** The member of the project's group on the target, or null. */
  targetProjectId: string | null;
  targetHasProject: boolean;
  existingTargetWorktree?: ExistingTargetWorkspace;
  /** Empty when the move may go ahead. */
  refusals: WorkspaceMoveRefusal[];
}

/** Which step of a move: the ids the progress dialog labels. */
export type WorkspaceMoveStepId =
  | "push"
  | "setUp"
  | "create"
  | "setupScript"
  | "restore"
  | "agents"
  | "removeSource";

/** One planned step. `detail` says more where a step repeats: an agent's kind. */
export interface WorkspaceMoveStep {
  id: WorkspaceMoveStepId;
  detail?: string;
}

/** A step a `WorkspaceRecreator` runs: the layout, then each agent. */
export interface RecreateStep extends WorkspaceMoveStep {
  id: "restore" | "agents";
}

export type WorkspaceMoveProgress =
  /** Sent first: every step that applies, in order, so a dialog can say "k of N". */
  | { type: "plan"; steps: WorkspaceMoveStep[] }
  | {
      type: "step";
      /** The step's place in the plan. */
      index: number;
      step: WorkspaceMoveStepId;
      /** `skipped`: planned, but it turned out not to apply (no start script). */
      status: "running" | "done" | "skipped" | "failed";
      error?: string;
    };

export interface WorkspaceMoveRequest {
  /** The source workspace's project. */
  projectId: string;
  /** The source workspace's path on its host. */
  path: string;
  targetHostId: string;
  /** Leave the source workspace where it is. */
  keepSource?: boolean;
}

export type WorkspaceMoveResult =
  | {
      ok: true;
      targetProjectId: string;
      targetPath: string;
      targetWorkspaceKey: WorkspaceKey;
      /** True when the target's existing workspace on the branch was used. */
      reused: boolean;
      sourceRemoved: boolean;
    }
  /** Preflight refused it; nothing ran. */
  | { ok: false; refusals: WorkspaceMoveRefusal[] }
  /** The set up needs the user: open the Set up dialog with this. */
  | { ok: false; needsInput: Extract<TransferResult, { ok: false }>["needsInput"] }
  /** A step failed. Steps before it stay done; the source is untouched. */
  | { ok: false; step: WorkspaceMoveStepId; error: string };

/** Both ends of a move, for whatever recreates the workspace's contents. */
export interface RecreateContext {
  sourceProjectId: string;
  sourceHostId: string;
  sourcePath: string;
  sourceKey: WorkspaceKey;
  targetProjectId: string;
  targetHostId: string;
  targetPath: string;
  targetKey: WorkspaceKey;
  branch: string;
}

/**
 * The seam for what a move carries beyond the worktree: the layout
 * (`restore`) and the agents (`agents`). `plan` runs before any step, from
 * the source alone, so its steps are in the plan the dialog shows; `run`
 * runs after the target workspace exists, calling `begin(i)` as it starts
 * its `i`th planned step. A throw fails the move at that step, before the
 * source is removed.
 */
export interface WorkspaceRecreator {
  plan(source: {
    projectId: string;
    hostId: string;
    path: string;
    key: WorkspaceKey;
  }): Promise<RecreateStep[]>;
  run(move: RecreateContext, begin: (index: number) => void): Promise<void>;
}

/** Recreates nothing: the default until the layout and agents come along. */
export const NO_RECREATE: WorkspaceRecreator = {
  plan: async () => [],
  run: async () => {},
};

/** A new workspace on a target, as the move asks for it. */
export interface CreateOnTarget {
  name: string;
  branch: string;
  linkedIssue?: LinkedIssue;
  folderId?: string | null;
}

/** What a move needs of the server, injected so tests fake each host. */
export interface WorkspaceHostMoveDeps {
  /** Every project, this desktop's and adopted hosts', in the desktop's form. */
  projects(): Promise<ProjectInfo[]>;
  /** Throw for an unknown host; connect (waking) a remote one. */
  connect(hostId: string): Promise<void>;
  /** `hostId`'s git, wherever it is. */
  git(hostId: string): Pick<GitBackend, "exec" | "pushStream">;
  /** Set the project up on `hostId` (`transferProject`, copy). */
  setUp(projectId: string, hostId: string): Promise<TransferResult>;
  /**
   * Make a workspace in `target` and run its start script, waiting for it.
   * `setup` is how the script ended: absent when none ran, `started` when
   * it runs on a host server that is not waited on.
   */
  createWorkspace(
    target: ProjectInfo,
    req: CreateOnTarget,
  ): Promise<{ workspacePath: string | null; setup?: SetupScriptEnd | "started" }>;
  createFolder(target: ProjectInfo, name: string): Promise<WorkspaceFolder | null>;
  linkIssue(target: ProjectInfo, workspacePath: string, issue: LinkedIssue): Promise<void>;
  /** The normal removal path: teardown script, panes ended, branch kept. */
  removeWorkspace(project: ProjectInfo, workspacePath: string): Promise<void>;
  recreator?: WorkspaceRecreator;
}

// ── Git reads ──

type Git = Pick<GitBackend, "exec" | "pushStream">;

/** Resolves to whether `git args` exits 0. */
function succeeds(git: Git, cwd: string, args: string[]): Promise<boolean> {
  return git.exec(cwd, args).then(
    () => true,
    () => false,
  );
}

/**
 * Every uncommitted and untracked file, asked with explicit flags so a
 * repo's `status.showUntrackedFiles=no` can't hide one. `-z` keeps paths
 * with spaces whole; a rename's second entry (its old path) is skipped.
 */
export async function dirtyFilesAt(git: Git, cwd: string): Promise<DirtyFile[]> {
  const out = await git.exec(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  const entries = out.split("\0");
  const files: DirtyFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push({ code, path: entry.slice(3) });
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return files;
}

/** The checked-out branch, or null for a detached HEAD. */
async function currentBranch(git: Git, cwd: string): Promise<string | null> {
  try {
    const name = (await git.exec(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).trim();
    return name || null;
  } catch {
    return null;
  }
}

/** `origin/<branch>`-style upstream, or null when there is none. */
async function upstreamOf(git: Git, cwd: string): Promise<string | null> {
  try {
    const name = (
      await git.exec(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    ).trim();
    return name || null;
  } catch {
    return null;
  }
}

/** Commits at HEAD that `upstream` (or, without one, any `origin` ref) lacks. */
async function aheadOf(git: Git, cwd: string, upstream: string | null): Promise<number | undefined> {
  const args = upstream
    ? ["rev-list", "--count", `${upstream}..HEAD`]
    : ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"];
  try {
    const count = Number((await git.exec(cwd, args)).trim());
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

/** `git push [--set-upstream] origin <branch>`, rejecting with git's stderr. */
function push(git: Git, cwd: string, branch: string, setUpstream: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    git.pushStream(
      cwd,
      { remote: "origin", branch, setUpstream },
      {
        onLine: () => {},
        onDone: ({ exitCode, stderr }) => {
          if (exitCode === 0) resolve();
          else reject(new Error(stderr.trim() || `git push exited with code ${exitCode}`));
        },
      },
    );
  });
}

// ── Preflight ──

/** The project and workspace a request names; throws when either is unknown. */
function sourceOf(
  projects: readonly ProjectInfo[],
  projectId: string,
  path: string,
): { project: ProjectInfo; workspace: WorkspaceInfo } {
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);
  const workspace = project.workspaces.find((ws) => ws.path === path);
  if (!workspace) throw new Error(`"${path}" is not a workspace of ${project.name}.`);
  return { project, workspace };
}

/** The member of `project`'s group on `hostId`, if any. An ungrouped project has none. */
function memberOn(
  projects: readonly ProjectInfo[],
  project: ProjectInfo,
  hostId: string,
): ProjectInfo | undefined {
  const groupId = project.group?.id;
  if (!groupId) return undefined;
  return projects.find((p) => p.group?.id === groupId && p.hostId === hostId);
}

/**
 * `target`'s workspace on `branch`, if any, with whether it is dirty and
 * whether the source's head contains its head (so an ff-only merge brings
 * it up to date). Asked of the source: the target can't see the source's
 * unpushed commits yet, and a head the source lacks is not fast-forwardable.
 */
async function existingOn(
  deps: WorkspaceHostMoveDeps,
  target: ProjectInfo,
  branch: string,
  source: { hostId: string; path: string },
): Promise<(ExistingTargetWorkspace & { dirtyFiles: DirtyFile[] }) | undefined> {
  const ws = target.workspaces.find((w) => branchesEqual(w.branch, branch));
  if (!ws) return undefined;
  const git = deps.git(target.hostId);
  const dirtyFiles = await dirtyFilesAt(git, ws.path);
  const dirty = dirtyFiles.length > 0;
  let canFastForward = false;
  try {
    const head = (await git.exec(ws.path, ["rev-parse", "HEAD"])).trim();
    canFastForward =
      head !== "" &&
      (await succeeds(deps.git(source.hostId), source.path, [
        "merge-base",
        "--is-ancestor",
        head,
        "HEAD",
      ]));
  } catch {
    canFastForward = false;
  }
  return { path: ws.path, dirty, canFastForward, dirtyFiles };
}

/**
 * What moving `path` (a workspace of `projectId`) to `targetHostId` would
 * do, and what refuses it. Reads both hosts through their own git; changes
 * nothing, and wakes no host. Throws for an unknown project or workspace,
 * or when a host can't be read.
 */
export async function preflightWorkspaceMove(
  deps: WorkspaceHostMoveDeps,
  req: Pick<WorkspaceMoveRequest, "projectId" | "path" | "targetHostId">,
): Promise<WorkspaceMovePreflight> {
  const projects = await deps.projects();
  const { project, workspace } = sourceOf(projects, req.projectId, req.path);
  const sourceHostId = project.hostId ?? LOCAL_HOST_ID;
  const git = deps.git(sourceHostId);
  const cwd = workspace.path;

  const [branch, hasOrigin, dirtyFiles, upstream] = await Promise.all([
    currentBranch(git, cwd),
    succeeds(git, cwd, ["remote", "get-url", "origin"]),
    dirtyFilesAt(git, cwd),
    upstreamOf(git, cwd),
  ]);
  const aheadCount = hasOrigin ? await aheadOf(git, cwd, upstream) : undefined;
  const branchName = branch ?? workspace.branch;
  const needsPush = upstream !== `origin/${branchName}` || aheadCount !== 0;

  const refusals: WorkspaceMoveRefusal[] = [];
  if (workspace.isMain) refusals.push({ code: "main-workspace" });
  if (req.targetHostId === sourceHostId) refusals.push({ code: "same-host" });
  if (dirtyFiles.length > 0) refusals.push({ code: "dirty", files: dirtyFiles });
  if (!hasOrigin) refusals.push({ code: "no-origin" });
  if (branch === null) refusals.push({ code: "detached" });

  const member = memberOn(projects, project, req.targetHostId);
  let existingTargetWorktree: ExistingTargetWorkspace | undefined;
  if (member && branch !== null && !workspace.isMain && req.targetHostId !== sourceHostId) {
    const existing = await existingOn(deps, member, branch, { hostId: sourceHostId, path: cwd });
    if (existing) {
      const { dirtyFiles: files, ...rest } = existing;
      existingTargetWorktree = rest;
      if (rest.dirty) refusals.push({ code: "target-dirty", files });
      else if (!rest.canFastForward) refusals.push({ code: "target-cannot-fast-forward" });
    }
  }

  return {
    sourceHostId,
    branch: branchName,
    name: workspace.name ?? branchName,
    isMain: workspace.isMain,
    hasOrigin,
    dirtyFiles,
    ...(aheadCount !== undefined ? { aheadCount } : {}),
    needsPush,
    targetProjectId: member?.id ?? null,
    targetHasProject: member !== undefined,
    ...(existingTargetWorktree ? { existingTargetWorktree } : {}),
    refusals,
  };
}

// ── The move ──

/** Thrown by a step to fail the move there. */
class StepFailure extends Error {
  constructor(
    readonly step: WorkspaceMoveStepId,
    message: string,
  ) {
    super(message);
  }
}

/** Why a start script failed the move, or null when it finished (or was killed). */
function setupFailure(setup: SetupScriptEnd): string | null {
  switch (setup.status) {
    case "exited":
      return setup.exitCode ? `The start script exited with code ${setup.exitCode}` : null;
    case "failed":
      return `The start script could not start: ${setup.error}`;
    case "timed-out":
      return "The start script was still running when the move stopped waiting";
  }
}

/** The target's folder named like the source's, made when it has none; null for none. */
async function folderOnTarget(
  deps: WorkspaceHostMoveDeps,
  source: ProjectInfo,
  folderId: string | null | undefined,
  target: ProjectInfo,
): Promise<string | null> {
  if (!folderId) return null;
  const name = source.folders?.find((f) => f.id === folderId)?.name;
  if (!name) return null;
  const existing = target.folders?.find((f) => f.name === name);
  if (existing) return existing.id;
  return (await deps.createFolder(target, name))?.id ?? null;
}

/** Bring the target's checkout of `branch` up to `origin`'s, fast-forward only. */
async function fastForward(git: Git, cwd: string, branch: string): Promise<void> {
  await git.exec(cwd, ["fetch", "origin", branch]);
  await git.exec(cwd, ["merge", "--ff-only", `origin/${branch}`]);
}

/**
 * Reports a move's steps against its plan: each `begin` finishes the step
 * running (done) and starts the next planned one with that id.
 */
function stepTracker(
  steps: readonly WorkspaceMoveStep[],
  onProgress: (event: WorkspaceMoveProgress) => void,
) {
  let current = -1;
  let open = false;
  const emit = (index: number, status: "running" | "done" | "skipped" | "failed", error?: string) =>
    onProgress({
      type: "step",
      index,
      step: steps[index].id,
      status,
      ...(error !== undefined ? { error } : {}),
    });
  const close = () => {
    if (open) emit(current, "done");
    open = false;
  };
  const next = (id: WorkspaceMoveStepId) => steps.findIndex((s, i) => i > current && s.id === id);
  const beginAt = (index: number) => {
    close();
    current = index;
    open = true;
    emit(index, "running");
  };
  return {
    beginAt,
    /** Start the next `id` step; throws when none is planned, unless `ifPlanned`. */
    begin(id: WorkspaceMoveStepId, opts: { ifPlanned?: boolean } = {}) {
      const index = next(id);
      if (index < 0) {
        if (opts.ifPlanned) return;
        throw new Error(`Move step "${id}" was not planned.`);
      }
      beginAt(index);
    },
    /** Mark the next `id` step skipped, if one is planned. */
    skip(id: WorkspaceMoveStepId) {
      const index = next(id);
      if (index < 0) return;
      close();
      current = index;
      emit(index, "skipped");
    },
    finish: close,
    fail(error: string) {
      if (open) emit(current, "failed", error);
      open = false;
    },
    currentId: (): WorkspaceMoveStepId | null => (current >= 0 ? steps[current].id : null),
  };
}

/**
 * Move the workspace at `req.path` to `req.targetHostId` (see the module
 * header). Preflight runs again first, and any refusal stops the move
 * before it touches anything. `onProgress` hears the plan, then each step.
 */
export async function moveWorkspaceToHost(
  deps: WorkspaceHostMoveDeps,
  req: WorkspaceMoveRequest,
  onProgress: (event: WorkspaceMoveProgress) => void = () => {},
): Promise<WorkspaceMoveResult> {
  const recreator = deps.recreator ?? NO_RECREATE;
  const before = await deps.projects();
  const { project: source, workspace } = sourceOf(before, req.projectId, req.path);
  const sourceHostId = source.hostId ?? LOCAL_HOST_ID;
  const { targetHostId } = req;

  await deps.connect(sourceHostId);
  await deps.connect(targetHostId);
  const pre = await preflightWorkspaceMove(deps, req);
  if (pre.refusals.length > 0) return { ok: false, refusals: pre.refusals };

  const branch = pre.branch;
  const sourceKey = workspaceKey(sourceHostId, workspace.path);
  const knownTarget = pre.targetProjectId
    ? before.find((p) => p.id === pre.targetProjectId)
    : undefined;
  const reusing = pre.existingTargetWorktree !== undefined;
  // A project set up during the move takes its start script from the
  // group, so the source's stands in for it in the plan.
  const startScript = (knownTarget ?? source).worktreeStartScript;
  const recreateSteps = await recreator.plan({
    projectId: source.id,
    hostId: sourceHostId,
    path: workspace.path,
    key: sourceKey,
  });

  const steps: WorkspaceMoveStep[] = [];
  if (pre.needsPush) steps.push({ id: "push" });
  if (!pre.targetHasProject) steps.push({ id: "setUp" });
  steps.push({ id: "create" });
  if (!reusing && startScript) steps.push({ id: "setupScript" });
  for (const step of recreateSteps) steps.push({ ...step });
  if (!req.keepSource) steps.push({ id: "removeSource" });
  onProgress({ type: "plan", steps: steps.map((s) => ({ ...s })) });

  const progress = stepTracker(steps, onProgress);

  try {
    // 1. Push.
    if (pre.needsPush) {
      progress.begin("push");
      const upstream = await upstreamOf(deps.git(sourceHostId), workspace.path);
      await push(deps.git(sourceHostId), workspace.path, branch, upstream === null);
    }

    // 2. Set up.
    let target = knownTarget;
    if (!target) {
      progress.begin("setUp");
      const result = await deps.setUp(source.id, targetHostId);
      if (!result.ok) {
        progress.fail("The set up needs input");
        return result;
      }
      target = (await deps.projects()).find((p) => p.id === result.project.id) ?? result.project;
    }

    // 3. Create, or reuse the target's workspace on the branch.
    progress.begin("create");
    const targetGit = deps.git(targetHostId);
    let targetPath: string;
    const existing = target.workspaces.find((w) => branchesEqual(w.branch, branch));
    if (existing) {
      // A set up that adopted a checkout may bring a workspace preflight
      // couldn't see: hold it to the same rules.
      if (!reusing) {
        if ((await dirtyFilesAt(targetGit, existing.path)).length > 0) {
          throw new StepFailure("create", `${existing.path} has uncommitted changes.`);
        }
      }
      try {
        await fastForward(targetGit, existing.path, branch);
      } catch (err) {
        throw new StepFailure(
          "create",
          `Could not fast-forward ${existing.path} to origin/${branch}: ${errorMessage(err)}`,
        );
      }
      targetPath = existing.path;
      progress.skip("setupScript");
    } else {
      const issues = workspace.linkedIssues ?? [];
      const folderId = await folderOnTarget(deps, source, workspace.folderId, target);
      const created = await deps.createWorkspace(target, {
        name: pre.name,
        branch,
        ...(issues[0] ? { linkedIssue: issues[0] } : {}),
        ...(folderId ? { folderId } : {}),
      });
      if (!created.workspacePath) {
        throw new StepFailure("create", `The workspace was not created on the target.`);
      }
      targetPath = created.workspacePath;
      for (const issue of issues.slice(1)) {
        await deps.linkIssue(target, targetPath, issue);
      }
      // `useExistingBranch` checks out a local branch the target already
      // had, which may be behind what was just pushed.
      await fastForward(targetGit, targetPath, branch);

      if (created.setup !== undefined) {
        progress.begin("setupScript", { ifPlanned: true });
        const failed = created.setup === "started" ? null : setupFailure(created.setup);
        if (failed) throw new StepFailure("setupScript", failed);
      } else {
        progress.skip("setupScript");
      }
    }
    const targetKey = workspaceKey(targetHostId, targetPath);

    // 4. Layout and agents.
    if (recreateSteps.length > 0) {
      const first = steps.length - recreateSteps.length - (req.keepSource ? 0 : 1);
      await recreator.run(
        {
          sourceProjectId: source.id,
          sourceHostId,
          sourcePath: workspace.path,
          sourceKey,
          targetProjectId: target.id,
          targetHostId,
          targetPath,
          targetKey,
          branch,
        },
        (index) => {
          if (Number.isInteger(index) && index >= 0 && index < recreateSteps.length) {
            progress.beginAt(first + index);
          }
        },
      );
    }

    // 5. Remove the source.
    if (!req.keepSource) {
      progress.begin("removeSource");
      await deps.removeWorkspace(source, workspace.path);
    }
    progress.finish();

    return {
      ok: true,
      targetProjectId: target.id,
      targetPath,
      targetWorkspaceKey: targetKey,
      reused: existing !== undefined,
      sourceRemoved: !req.keepSource,
    };
  } catch (err) {
    const step = err instanceof StepFailure ? err.step : (progress.currentId() ?? "create");
    const error = errorMessage(err);
    progress.fail(error);
    return { ok: false, step, error };
  }
}

// ── The server's deps ──

/**
 * The deps a move runs over in the desktop's Manor server. Git goes through
 * each host's backend; a workspace write goes through `WorkspaceOps` for a
 * project this desktop holds (local, or on a host not yet adopted), which
 * runs and waits for the start script here, and through the host's server
 * for a project on an adopted host, which starts the script there.
 */
export function createWorkspaceHostMoveDeps(server: {
  projectManager: Pick<
    ProjectManager,
    | "getProjects"
    | "assertKnownHost"
    | "isRemoteProject"
    | "transferProject"
    | "createWorkspaceFolder"
    | "linkIssueToWorkspace"
  >;
  workspaceOps: Pick<WorkspaceOps, "create" | "remove">;
  backendRegistry: Pick<BackendRegistry, "get" | "ensureConnected">;
  hostRouting?: Pick<HostRouting, "remoteProjects" | "proxy">;
  recreator?: WorkspaceRecreator;
  /** How long to wait for a start script; 10 minutes by default. */
  setupTimeoutMs?: number;
}): WorkspaceHostMoveDeps {
  const pm = server.projectManager;
  const remote = server.hostRouting?.remoteProjects();
  const onServer = (project: ProjectInfo) => pm.isRemoteProject(project.id);
  const remoteCall = (hostId: string, method: string, args: unknown[]) => {
    if (!remote) throw new Error(`${hostId} has no host server to answer.`);
    return remote.call(hostId, method, args);
  };
  const setupTimeoutMs = server.setupTimeoutMs ?? 10 * 60_000;

  return {
    projects: () => pm.getProjects(),
    async connect(hostId) {
      pm.assertKnownHost(hostId);
      if (hostId !== LOCAL_HOST_ID) await server.backendRegistry.ensureConnected(hostId);
    },
    git: (hostId) => server.backendRegistry.get(hostId).git,
    setUp: (projectId, hostId) => pm.transferProject(projectId, hostId, "copy"),

    async createWorkspace(target, req) {
      const opts: Omit<CreateWorktreeOptions, "origin"> = {
        branch: req.branch,
        useExistingBranch: true,
        ...(req.linkedIssue ? { linkedIssue: req.linkedIssue } : {}),
        ...(req.folderId ? { folderId: req.folderId } : {}),
      };
      if (onServer(target)) {
        const before = new Set(target.workspaces.map((ws) => ws.path));
        const updated = (await remoteCall(target.hostId, "createWorktree", [
          target.id,
          req.name,
          opts,
        ])) as ProjectInfo | null;
        const made = updated?.workspaces.find(
          (ws) => !ws.isMain && !before.has(ws.path) && branchesEqual(ws.branch, req.branch),
        );
        return {
          workspacePath: made?.path ?? null,
          ...(made && updated?.worktreeStartScript ? { setup: "started" as const } : {}),
        };
      }
      const { workspacePath, setup } = await server.workspaceOps.create({
        projectId: target.id,
        name: req.name,
        ...opts,
        awaitSetup: { timeoutMs: setupTimeoutMs },
      });
      return { workspacePath, ...(setup ? { setup } : {}) };
    },

    async createFolder(target, name) {
      if (onServer(target)) {
        return (await remoteCall(target.hostId, "createWorkspaceFolder", [
          target.id,
          name,
        ])) as WorkspaceFolder | null;
      }
      return pm.createWorkspaceFolder(target.id, name);
    },

    async linkIssue(target, workspacePath, issue) {
      if (onServer(target)) {
        const proxy = server.hostRouting?.proxy(target.hostId);
        if (!proxy) throw new Error(`${target.hostId} is offline`);
        await proxy.invoke("linear", "linkIssueToWorkspace", [target.id, workspacePath, issue]);
        return;
      }
      pm.linkIssueToWorkspace(target.id, workspacePath, issue);
    },

    async removeWorkspace(project, workspacePath) {
      if (onServer(project)) {
        await remoteCall(project.hostId, "removeWorktree", [project.id, workspacePath, false]);
        return;
      }
      await server.workspaceOps.remove(project.id, workspacePath, false);
    },

    ...(server.recreator ? { recreator: server.recreator } : {}),
  };
}
