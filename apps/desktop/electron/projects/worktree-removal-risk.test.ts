/**
 * `worktreeRemovalRisk` over a real repo: what removing a worktree unasked
 * would lose — changes, untracked files, submodules, commits on neither the
 * default branch nor a remote, and ignored files changed since the run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
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

  it("sees untracked files even when the repo hides them from status", async () => {
    git(repo, "config", "status.showUntrackedFiles", "no");
    await writeFile(path.join(wt, "new.txt"), "x\n");
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBe("Uncommitted changes in workspace");
  });

  describe("ignored files", () => {
    const LONG_AGO = Date.now() - 60 * 60_000;

    beforeEach(async () => {
      await writeFile(path.join(repo, ".git", "info", "exclude"), ".env\nnode_modules/\nreports/\ngen/\n");
    });

    it("keeps an ignored file written after the run's setup grace", async () => {
      await writeFile(path.join(wt, ".env"), "SECRET=1\n");
      expect(await worktreeRemovalRisk(ctx, "p1", wt, { createdAt: LONG_AGO })).toBe(
        "Ignored file changed since the run: .env",
      );
    });

    it("keeps a file an agent left inside an ignored folder", async () => {
      await mkdir(path.join(wt, "reports", "daily"), { recursive: true });
      await writeFile(path.join(wt, "reports", "daily", "out.md"), "# report\n");
      const old = new Date(LONG_AGO);
      await utimes(path.join(wt, "reports"), old, old);
      await utimes(path.join(wt, "reports", "daily"), old, old);
      expect(await worktreeRemovalRisk(ctx, "p1", wt, { createdAt: LONG_AGO })).toBe(
        `Ignored file changed since the run: ${path.join("reports", "daily", "out.md")}`,
      );
    });

    it("lets ignored files the setup script wrote in its first minutes go", async () => {
      await writeFile(path.join(wt, ".env"), "SECRET=1\n");
      expect(await worktreeRemovalRisk(ctx, "p1", wt, { createdAt: Date.now() - 30_000 })).toBeNull();
    });

    it("falls back to the worktree's own age when the run's isn't given", async () => {
      await writeFile(path.join(wt, ".env"), "SECRET=1\n");
      expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBeNull();
    });

    it("ignores dependency folders however new", async () => {
      await mkdir(path.join(wt, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(wt, "node_modules", "pkg", "index.js"), "x\n");
      expect(await worktreeRemovalRisk(ctx, "p1", wt, { createdAt: LONG_AGO })).toBeNull();
    });

    it("keeps the workspace when there are too many ignored files to check", async () => {
      await mkdir(path.join(wt, "gen"));
      const old = new Date(LONG_AGO);
      for (let i = 0; i < 2001; i++) {
        const file = path.join(wt, "gen", `f${i}.txt`);
        await writeFile(file, "");
        await utimes(file, old, old);
      }
      await utimes(path.join(wt, "gen"), old, old);
      expect(await worktreeRemovalRisk(ctx, "p1", wt, { createdAt: LONG_AGO })).toBe(
        "Too many ignored files to check",
      );
    });
  });

  it("keeps a worktree with submodules", async () => {
    await writeFile(path.join(repo, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ../x\n');
    git(repo, "add", ".gitmodules");
    git(repo, "commit", "-m", "submodules");
    const wt2 = path.join(root, "wt2");
    git(repo, "worktree", "add", "-b", "auto/sub", wt2);
    expect(await worktreeRemovalRisk(ctx, "p1", wt2)).toBe("It has submodules");
  });

  it("resolves the default branch as a branch, falling back to origin's", async () => {
    const project = ctx.find("p1")!;
    project.defaultBranch = "trunk";
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBe("Could not find trunk");
    // A tag of that name is not the branch.
    git(repo, "tag", "trunk");
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBe("Could not find trunk");
    git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBeNull();
  });

  it("keeps a worktree on another host", async () => {
    ctx.find("p1")!.hostId = "box";
    expect(await worktreeRemovalRisk(ctx, "p1", wt)).toBe("It is on another host");
  });
});
