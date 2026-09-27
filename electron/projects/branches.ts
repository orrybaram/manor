/**
 * A project's branches: detecting its default branch, and listing local and
 * remote ones (ADR-183 split this out of `ProjectManager`).
 */

import type { GitBackend } from "../backend/types";
import { errorMessage } from "../lib/errors";
import type { ProjectContext } from "./context";

/**
 * LOCAL-ONLY: reads the symbolic ref for origin/HEAD with no network activity.
 * Returns the bare branch name (e.g. "main") or null on any failure.
 */
export async function detectDefaultBranchLocal(
  git: GitBackend,
  repoPath: string,
): Promise<string | null> {
  try {
    const stdout = await git.exec(repoPath, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    // Strip the leading "origin/" prefix (e.g. "origin/master" → "master").
    const prefix = "origin/";
    return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  } catch {
    return null;
  }
}

export async function detectDefaultBranch(
  git: GitBackend,
  repoPath: string,
): Promise<string | null> {
  try {
    // Step 1: Read the local symbolic ref for origin/HEAD — no network needed.
    const local = await detectDefaultBranchLocal(git, repoPath);
    if (local) return local;

    // Step 1 failed — try to set the remote HEAD pointer (one network round-trip).
    try {
      await git.exec(repoPath, ["remote", "set-head", "origin", "--auto"]);
    } catch (setHeadErr) {
      console.error(
        "[ProjectManager] detectDefaultBranch: remote set-head failed:",
        errorMessage(setHeadErr),
      );
    }

    // Retry step 1 after set-head.
    return await detectDefaultBranchLocal(git, repoPath);
  } catch (err) {
    console.error("[ProjectManager] detectDefaultBranch failed:", errorMessage(err));
    return null;
  }
}

/**
 * Re-detect the default branch for all persisted projects using local-only
 * detection (no network). Updates any stale values and saves once if anything
 * changed.
 */
export async function resyncDefaultBranches(ctx: ProjectContext): Promise<void> {
  let changed = false;
  for (const project of ctx.store.state.projects) {
    try {
      const detected = await detectDefaultBranchLocal(
        ctx.host(project.hostId).git,
        project.path,
      );
      if (detected && detected !== project.defaultBranch) {
        project.defaultBranch = detected;
        changed = true;
      }
    } catch (err) {
      // One bad repo must not abort the sweep.
      console.error(
        "[ProjectManager] resyncDefaultBranches: error for",
        project.path,
        errorMessage(err),
      );
    }
  }
  if (changed) ctx.store.save();
}

function parseBranches(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((b) => b && b !== "HEAD");
}

export async function listLocalBranches(
  ctx: ProjectContext,
  projectId: string,
): Promise<string[]> {
  const project = ctx.find(projectId);
  if (!project) return [];
  try {
    const stdout = await ctx.host(project.hostId).git.exec(project.path, [
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname:strip=2)",
      "refs/heads",
    ]);
    return parseBranches(stdout);
  } catch (err) {
    console.error("[ProjectManager] listLocalBranches failed:", errorMessage(err));
    return [];
  }
}

export async function listRemoteBranches(
  ctx: ProjectContext,
  projectId: string,
): Promise<string[]> {
  const project = ctx.find(projectId);
  if (!project) return [];
  const git = ctx.host(project.hostId).git;

  try {
    // Fetch latest remote refs so for-each-ref has up-to-date data
    await git.exec(project.path, ["fetch", "origin", "--prune"]);

    // Natural network touchpoint: refresh origin/HEAD (a plain fetch does NOT
    // update it) so an upstream default-branch rename is picked up here rather
    // than on every app launch, then resync this project's defaultBranch.
    // Best-effort — must never block branch listing. See ADR-144.
    try {
      await git.exec(project.path, ["remote", "set-head", "origin", "--auto"]);
      const detected = await detectDefaultBranchLocal(git, project.path);
      if (detected && detected !== project.defaultBranch) {
        project.defaultBranch = detected;
        ctx.store.save();
      }
    } catch (err) {
      console.error(
        "[ProjectManager] listRemoteBranches: default-branch refresh failed:",
        errorMessage(err),
      );
    }

    const stdout = await git.exec(project.path, [
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname:strip=3)",
      "refs/remotes/origin",
    ]);
    return parseBranches(stdout);
  } catch (err) {
    console.error(
      "[ProjectManager] git ls-remote --heads origin failed:",
      errorMessage(err),
    );
    return [];
  }
}
