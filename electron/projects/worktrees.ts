/**
 * A project's git worktrees: creating, removing, quick-merging and
 * converting the main checkout into one (ADR-183 split this out of
 * `ProjectManager`). Every git and shell call goes through the project's
 * own host.
 */

import { LOCAL_HOST_ID } from "../backend/types";
import { sanitizeBranchName, toDirSlug } from "../branch-name";
import { errorMessage } from "../lib/errors";
import type { ProjectContext } from "./context";
import { emitSetupProgress } from "./progress";
import type {
  IssueSeed,
  LinkedIssue,
  PersistedProject,
  ProjectInfo,
  WorkspaceFromIssue,
} from "./types";

/** The project's git, resolved per call so a long operation sees reconnects. */
function gitOf(ctx: ProjectContext, project: PersistedProject) {
  return () => ctx.host(project.hostId).git;
}

/** The branch checked out in `worktreePath`, or null. Logs a failed lookup as `what`. */
async function branchOfWorktree(
  ctx: ProjectContext,
  project: PersistedProject,
  worktreePath: string,
  what: string,
): Promise<string | null> {
  try {
    const worktrees = await ctx.host(project.hostId).git.worktreeList(project.path);
    return worktrees.find((wt) => wt.path === worktreePath)?.branch ?? null;
  } catch (err) {
    console.error(`[ProjectManager] ${what}failed to detect branch for worktree:`, errorMessage(err));
    return null;
  }
}

/**
 * Create one workspace (git worktree) per GitHub issue, each linked to its
 * issue. Runs sequentially — concurrent `git worktree add` on one repo races
 * the index. Per-issue errors are isolated so one failure never aborts the
 * batch. Takes pre-fetched issue seeds so this layer stays GitHub-agnostic.
 * Each worktree is made through `create` — `ProjectManager.createWorktree`.
 */
export async function createWorkspacesFromIssues(
  ctx: ProjectContext,
  projectId: string,
  issues: IssueSeed[],
  baseBranch: string | undefined,
  create: (
    projectId: string,
    name: string,
    branch: undefined,
    linkedIssue: LinkedIssue,
    baseBranch?: string,
  ) => Promise<unknown>,
): Promise<WorkspaceFromIssue[]> {
  const project = ctx.find(projectId);
  const results: WorkspaceFromIssue[] = [];
  for (const seed of issues) {
    const base = {
      number: seed.number,
      title: seed.title,
      body: seed.body ?? null,
      url: seed.url,
    };
    if (!project) {
      results.push({ ...base, error: "Project not found" });
      continue;
    }
    try {
      const linkedIssue: LinkedIssue = {
        id: String(seed.number),
        identifier: "#" + seed.number,
        title: seed.title,
        url: seed.url,
      };
      const name = toDirSlug(seed.title) || "issue-" + seed.number;
      const worktreePath = await ctx.paths.worktreePathFor(project, name);
      await create(projectId, name, undefined, linkedIssue, baseBranch);
      results.push({ ...base, worktreePath });
    } catch (err) {
      results.push({ ...base, error: String(err) });
    }
  }
  return results;
}

export async function createWorktree(
  ctx: ProjectContext,
  projectId: string,
  name: string,
  branch?: string,
  linkedIssue?: LinkedIssue,
  baseBranch?: string,
  useExistingBranch?: boolean,
): Promise<ProjectInfo | null> {
  const project = ctx.find(projectId);
  if (!project) return null;
  const git = gitOf(ctx, project);

  const branchName = sanitizeBranchName(branch || name);
  const worktreePath = await ctx.paths.worktreePathFor(project, name);

  // Prune stale worktree entries (e.g. leftover from a previous failed creation)
  emitSetupProgress("prune", "in-progress");
  try {
    await git().exec(project.path, ["worktree", "prune"]);
  } catch (err) {
    console.error("[ProjectManager] git worktree prune failed:", errorMessage(err));
  }
  emitSetupProgress("prune", "done");

  // If an existing branch was selected, fetch first so local refs are up-to-date
  emitSetupProgress("fetch", "in-progress");
  if (branch) {
    try {
      await git().exec(project.path, ["fetch", "origin", branchName]);
    } catch (err) {
      console.error("[ProjectManager] git fetch before checkout failed:", errorMessage(err));
    }
  } else {
    // Creating a new branch — fetch origin so we base off the latest remote refs
    try {
      await git().exec(project.path, ["fetch", "origin"]);
    } catch (err) {
      console.error(
        "[ProjectManager] git fetch origin before new worktree failed:",
        errorMessage(err),
      );
    }
  }
  emitSetupProgress("fetch", "done");

  const defaultBranchRef = baseBranch ?? `origin/${project.defaultBranch || "main"}`;

  if (useExistingBranch) {
    // Check out an existing remote branch without creating a new one
    emitSetupProgress("create-worktree", "in-progress", `Checking out branch ${branchName}`);
    try {
      // Try checking out as a local branch first
      await git().worktreeAdd(project.path, worktreePath, branchName);
    } catch {
      // Local branch doesn't exist — create local tracking branch from remote
      try {
        await git().worktreeAdd(project.path, worktreePath, branchName, {
          createBranch: true,
          startPoint: `origin/${branchName}`,
        });
      } catch (remoteErr) {
        console.error(
          "[ProjectManager] git worktree add existing branch failed:",
          errorMessage(remoteErr),
        );
        throw remoteErr;
      }
    }
  } else {
    emitSetupProgress(
      "create-worktree",
      "in-progress",
      branch
        ? `Checking out branch ${branchName}`
        : `Creating new branch ${branchName} from ${defaultBranchRef}`,
    );
    try {
      await git().worktreeAdd(project.path, worktreePath, branchName, {
        createBranch: true,
        startPoint: defaultBranchRef,
      });
    } catch (createErr) {
      console.error("[ProjectManager] git worktree add -b failed:", errorMessage(createErr));
      // Branch already exists — create worktree checking out the existing branch
      try {
        await git().worktreeAdd(project.path, worktreePath, branchName);
      } catch {
        // Neither new branch nor existing local branch — try remote tracking branch
        try {
          await git().exec(project.path, ["fetch", "origin", branchName]);
          await git().worktreeAdd(project.path, worktreePath, branchName, {
            createBranch: true,
            startPoint: `origin/${branchName}`,
          });
        } catch (remoteErr) {
          console.error(
            "[ProjectManager] git worktree add from remote also failed:",
            errorMessage(remoteErr),
          );
          throw remoteErr;
        }
      }
    }
  }
  emitSetupProgress("create-worktree", "done");

  // Set custom name only if it differs from the branch
  if (name !== branchName) {
    if (!project.workspaceNames) project.workspaceNames = {};
    project.workspaceNames[worktreePath] = name;
  }

  // Auto-link the issue if provided
  if (linkedIssue) {
    if (!project.workspaceIssues) project.workspaceIssues = {};
    const existing = project.workspaceIssues[worktreePath] ?? [];
    if (!existing.some((i) => i.id === linkedIssue.id)) {
      project.workspaceIssues[worktreePath] = [...existing, linkedIssue];
    }
  }

  emitSetupProgress("persist", "in-progress");
  ctx.store.save();
  emitSetupProgress("persist", "done");

  return ctx.info(project);
}

export async function convertMainToWorktree(
  ctx: ProjectContext,
  projectId: string,
  name: string,
): Promise<ProjectInfo | null> {
  const project = ctx.find(projectId);
  if (!project) return null;
  const git = gitOf(ctx, project);

  // Get the current branch of the main workspace
  const branchOut = await git().exec(project.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = branchOut.trim();

  if (currentBranch === project.defaultBranch) {
    throw new Error(
      `Main workspace is already on the default branch (${project.defaultBranch}). Nothing to convert.`,
    );
  }

  const worktreePath = await ctx.paths.worktreePathFor(project, name);

  // Prune stale worktree entries
  try {
    await git().exec(project.path, ["worktree", "prune"]);
  } catch (err) {
    console.error("[ProjectManager] git worktree prune failed:", errorMessage(err));
  }

  // Checkout the default branch first — the current branch must be
  // freed before git allows it to be checked out in a new worktree.
  await git().exec(project.path, ["checkout", project.defaultBranch || "main"]);

  // Create a worktree for the branch we just freed
  try {
    await git().worktreeAdd(project.path, worktreePath, currentBranch);
  } catch (worktreeErr) {
    // Roll back: re-checkout the original branch so the user isn't stranded
    try {
      await git().exec(project.path, ["checkout", currentBranch]);
    } catch (rollbackErr) {
      console.error(
        "[ProjectManager] failed to roll back to original branch after worktree failure:",
        errorMessage(rollbackErr),
      );
    }
    throw worktreeErr;
  }

  // Set custom name only if it differs from the branch
  if (name !== currentBranch) {
    if (!project.workspaceNames) project.workspaceNames = {};
    project.workspaceNames[worktreePath] = name;
  }

  ctx.store.save();

  return ctx.info(project);
}

export async function removeWorktree(
  ctx: ProjectContext,
  projectId: string,
  worktreePath: string,
  deleteBranch?: boolean,
  onProgress?: (step: string) => void,
): Promise<void> {
  const project = ctx.find(projectId);
  if (!project) return;
  const git = gitOf(ctx, project);

  const progress = onProgress ?? (() => {});

  // Detect the branch before removing the worktree
  let branchName: string | null = null;
  if (deleteBranch) {
    progress("Detecting branch…");
    branchName = await branchOfWorktree(ctx, project, worktreePath, "");
  }

  // Run worktree teardown script before removal, through the project's
  // host (ADR-178 §3). Remote hosts get a generous timeout since teardown
  // (e.g. `docker compose down`) can run well past a daemon's default exec
  // timeout; local keeps its original, tighter timeout.
  if (project.worktreeTeardownScript) {
    progress("Running teardown script…");
    const timeout = project.hostId === LOCAL_HOST_ID ? 30000 : 10 * 60 * 1000;
    try {
      await ctx
        .host(project.hostId)
        .shell.exec("sh", ["-c", project.worktreeTeardownScript], {
          cwd: worktreePath,
          timeout,
        });
    } catch (err) {
      console.error("[ProjectManager] worktree teardown script failed:", errorMessage(err));
    }
  }

  progress("Removing worktree files…");
  try {
    await git().worktreeRemove(project.path, worktreePath, true);
  } catch (err) {
    const message = errorMessage(err);
    console.error("[ProjectManager] git worktree remove failed:", message);

    // Check if the directory is actually gone (e.g. already removed
    // externally), on the project's host (ADR-178 §3).
    if (await ctx.host(project.hostId).facts.exists(worktreePath)) {
      // Directory still exists — this is a real failure, surface it
      throw new Error(`Failed to remove worktree: ${message}`, { cause: err });
    }

    // Directory is gone — prune stale git metadata and continue
    progress("Pruning stale worktree entries…");
    try {
      await git().exec(project.path, ["worktree", "prune"]);
    } catch (pruneErr) {
      console.error("[ProjectManager] git worktree prune failed:", errorMessage(pruneErr));
    }
  }

  // Clean up workspace metadata
  progress("Cleaning up metadata…");
  if (project.workspaceNames) {
    delete project.workspaceNames[worktreePath];
  }
  if (project.workspaceOrder) {
    project.workspaceOrder = project.workspaceOrder.filter((p) => p !== worktreePath);
  }
  if (project.workspaceIssues) {
    delete project.workspaceIssues[worktreePath];
  }
  delete project.workspaceFolderIds?.[worktreePath];
  ctx.store.save();

  if (deleteBranch && branchName) {
    progress("Deleting branch…");
    try {
      await git().exec(project.path, ["branch", "-D", branchName]);
    } catch (err) {
      console.error("[ProjectManager] git branch -D failed:", errorMessage(err));
    }
  }
}

export async function canQuickMerge(
  ctx: ProjectContext,
  projectId: string,
  worktreePath: string,
): Promise<{ canMerge: boolean; reason?: string }> {
  const project = ctx.find(projectId);
  if (!project) return { canMerge: false, reason: "Project not found" };
  const git = gitOf(ctx, project);

  if (worktreePath === project.path) {
    return { canMerge: false, reason: "Cannot merge main workspace" };
  }

  // Detect branch name from worktree list
  const branchName = await branchOfWorktree(ctx, project, worktreePath, "canQuickMerge: ");

  // Check for uncommitted changes in source worktree
  try {
    const stdout = await git().exec(worktreePath, ["status", "--porcelain"]);
    if (stdout.trim().length > 0) {
      return { canMerge: false, reason: "Uncommitted changes in workspace" };
    }
  } catch (err) {
    console.error(
      "[ProjectManager] canQuickMerge: failed to check git status:",
      errorMessage(err),
    );
  }

  // Check for uncommitted changes in main worktree (merge target)
  try {
    const stdout = await git().exec(project.path, ["status", "--porcelain"]);
    if (stdout.trim().length > 0) {
      return { canMerge: false, reason: "Uncommitted changes in main workspace" };
    }
  } catch (err) {
    console.error(
      "[ProjectManager] canQuickMerge: failed to check main worktree git status:",
      errorMessage(err),
    );
  }

  // Check fast-forward eligibility
  if (branchName) {
    try {
      await git().exec(project.path, [
        "merge-base",
        "--is-ancestor",
        project.defaultBranch,
        branchName,
      ]);
    } catch {
      return { canMerge: false, reason: "Branch has diverged" };
    }
  }

  return { canMerge: true };
}

export async function quickMergeWorktree(
  ctx: ProjectContext,
  projectId: string,
  worktreePath: string,
): Promise<void> {
  const check = await canQuickMerge(ctx, projectId, worktreePath);
  if (!check.canMerge) {
    throw new Error(`[ProjectManager] quickMergeWorktree: cannot merge — ${check.reason}`);
  }

  const project = ctx.find(projectId);
  if (!project) return;

  const branchName = await branchOfWorktree(ctx, project, worktreePath, "quickMergeWorktree: ");
  if (!branchName) {
    throw new Error("[ProjectManager] quickMergeWorktree: could not detect branch name");
  }

  try {
    await ctx.host(project.hostId).git.exec(project.path, ["merge", "--ff-only", branchName]);
  } catch (err) {
    console.error(
      "[ProjectManager] quickMergeWorktree: git merge --ff-only failed:",
      errorMessage(err),
    );
    throw err;
  }

  await removeWorktree(ctx, projectId, worktreePath, true);
}
