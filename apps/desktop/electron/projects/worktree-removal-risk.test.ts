/**
 * `worktreeRemovalRisk` over a real repo: what removing a worktree unasked
 * would lose — changes, untracked files, commits on neither the default
 * branch nor a remote.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ExecGitBackend } from "../backend/exec-git";
import type { ProjectContext } from "./context";
import { worktreeRemovalRisk } from "./worktrees";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("worktreeRemovalRisk", () => {
  let root: string;
  let repo: string;
  let wt: string;
  let ctx: ProjectContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "manor-risk-")));
    repo = path.join(root, "repo");
    wt = path.join(root, "wt");
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.email", "test@test.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
    git(repo, "worktree", "add", "-b", "auto/run", wt);
    const project = { id: "p1", path: repo, defaultBranch: "main", hostId: "local" };
    const backend = new ExecGitBackend();
    ctx = {
      find: (id: string) => (id === "p1" ? project : undefined),
      host: () => ({ git: backend }),
    } as unknown as ProjectContext;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is null for a clean worktree with nothing of its own", async () => {
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBeNull();
  });

  it("names uncommitted changes, untracked files included", async () => {
    await writeFile(path.join(wt, "new.txt"), "x\n");
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBe("Uncommitted changes in workspace");
  });

  it("names commits on neither the default branch nor a remote", async () => {
    await writeFile(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-m", "work");
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBe("1 commit on neither main nor a remote");
  });

  it("is null once those commits are merged into the default branch", async () => {
    await writeFile(path.join(wt, "b.txt"), "b\n");
    git(wt, "add", ".");
    git(wt, "commit", "-m", "work");
    git(repo, "merge", "--ff-only", "auto/run");
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBeNull();
  });

  it("refuses the main workspace and an unknown project", async () => {
    expect(await worktreeRemovalRisk(ctx, "p1", repo)).toBe("It is the main workspace");
    expect(await worktreeRemovalRisk(ctx, "nope", wt)).toBe("Project not found");
  });

  it("counts a path git can't read as a risk", async () => {
    expect(await worktreeRemovalRisk(ctx, "p1", path.join(root, "gone"))).toMatch(/^Could not read git status/);
  });
});
