import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalGitBackend } from "./local-git";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("LocalGitBackend", () => {
  let backend: LocalGitBackend;
  let tmpDir: string;

  beforeEach(async () => {
    backend = new LocalGitBackend();
    tmpDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "manor-test-")));
    git(tmpDir, "init", "-b", "main");
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test");
    await writeFile(path.join(tmpDir, "file.txt"), "hello\n");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "initial");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("exec", () => {
    it("returns stdout from git commands", async () => {
      const out = await backend.exec(tmpDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      expect(out.trim()).toBe("main");
    });
  });

  describe("stage / unstage / getStagedFiles", () => {
    it("stages and unstages files", async () => {
      await writeFile(path.join(tmpDir, "new.txt"), "new\n");
      await backend.stage(tmpDir, ["new.txt"]);

      const staged = await backend.getStagedFiles(tmpDir);
      expect(staged).toContain("new.txt");

      await backend.unstage(tmpDir, ["new.txt"]);
      const after = await backend.getStagedFiles(tmpDir);
      expect(after).not.toContain("new.txt");
    });
  });

  describe("discard", () => {
    it("discards tracked file modifications", async () => {
      await writeFile(path.join(tmpDir, "file.txt"), "modified\n");
      await backend.discard(tmpDir, ["file.txt"]);

      const out = await backend.exec(tmpDir, ["diff", "--name-only"]);
      expect(out.trim()).toBe("");
    });

    it("discards untracked files", async () => {
      await writeFile(path.join(tmpDir, "untracked.txt"), "untracked\n");
      await backend.discard(tmpDir, ["untracked.txt"]);

      const out = await backend.exec(tmpDir, ["status", "--porcelain"]);
      expect(out.trim()).toBe("");
    });
  });

  describe("commit", () => {
    it("commits with a message", async () => {
      await writeFile(path.join(tmpDir, "c.txt"), "commit me\n");
      await backend.stage(tmpDir, ["c.txt"]);
      await backend.commit(tmpDir, "test commit", []);

      const log = await backend.exec(tmpDir, ["log", "--oneline", "-1"]);
      expect(log).toContain("test commit");
    });

    it("filters disallowed flags", async () => {
      await writeFile(path.join(tmpDir, "d.txt"), "data\n");
      await backend.stage(tmpDir, ["d.txt"]);
      await backend.commit(tmpDir, "safe commit", ["--force-with-lease", "--allow-empty"]);

      const log = await backend.exec(tmpDir, ["log", "--oneline", "-1"]);
      expect(log).toContain("safe commit");
    });

    it("throws when message is empty and not amending", async () => {
      await expect(backend.commit(tmpDir, "", [])).rejects.toThrow(
        "Commit message is required",
      );
    });

    it("allows amend without message", async () => {
      await writeFile(path.join(tmpDir, "e.txt"), "data\n");
      await backend.stage(tmpDir, ["e.txt"]);
      await backend.commit(tmpDir, "", ["--amend"]);

      const log = await backend.exec(tmpDir, ["log", "--oneline", "-1"]);
      expect(log).toContain("initial");
    });
  });

  describe("stash", () => {
    it("stashes files", async () => {
      await writeFile(path.join(tmpDir, "file.txt"), "modified\n");
      await backend.stash(tmpDir, ["file.txt"]);

      const status = await backend.exec(tmpDir, ["status", "--porcelain"]);
      expect(status.trim()).toBe("");

      const stashList = await backend.exec(tmpDir, ["stash", "list"]);
      expect(stashList).toContain("stash@{0}");
    });
  });

  describe("getLocalDiff", () => {
    it("returns null when clean", async () => {
      const diff = await backend.getLocalDiff(tmpDir);
      expect(diff).toBeNull();
    });

    it("returns diff for modified files", async () => {
      await writeFile(path.join(tmpDir, "file.txt"), "changed\n");
      const diff = await backend.getLocalDiff(tmpDir);
      expect(diff).toContain("changed");
    });

    it("includes untracked files as synthetic diffs", async () => {
      await writeFile(path.join(tmpDir, "untracked.txt"), "new content\n");
      const diff = await backend.getLocalDiff(tmpDir);
      expect(diff).toContain("untracked.txt");
      expect(diff).toContain("+new content");
    });
  });

  describe("worktreeList", () => {
    it("parses single worktree (main repo)", async () => {
      const result = await backend.worktreeList(tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe(tmpDir);
      expect(result[0].branch).toBe("main");
      expect(result[0].isMain).toBe(true);
    });

    it("parses multiple worktrees", async () => {
      const wtPath = path.join(tmpDir, "wt-feature");
      git(tmpDir, "worktree", "add", "-b", "feature", wtPath);

      const result = await backend.worktreeList(tmpDir);
      expect(result).toHaveLength(2);

      const main = result.find((w) => w.isMain);
      const feature = result.find((w) => !w.isMain);
      expect(main?.branch).toBe("main");
      expect(feature?.branch).toBe("feature");
      expect(feature?.path).toBe(wtPath);

      git(tmpDir, "worktree", "remove", wtPath);
    });
  });

  describe("worktreeAdd / worktreeRemove", () => {
    it("adds and removes a worktree", async () => {
      const wtPath = path.join(tmpDir, "wt-test");
      await backend.worktreeAdd(tmpDir, wtPath, "test-branch", {
        createBranch: true,
      });

      const list = await backend.worktreeList(tmpDir);
      expect(list).toHaveLength(2);
      expect(list.some((w) => w.branch === "test-branch")).toBe(true);

      await backend.worktreeRemove(tmpDir, wtPath, true);
      const after = await backend.worktreeList(tmpDir);
      expect(after).toHaveLength(1);
    });
  });
});
