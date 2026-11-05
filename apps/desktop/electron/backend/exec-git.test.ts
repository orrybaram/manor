import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExecGitBackend, MAX_UNTRACKED_DIFF_BYTES } from "./exec-git";
import { localExec } from "./exec";
import { mkdir, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("ExecGitBackend", () => {
  let backend: ExecGitBackend;
  let tmpDir: string;

  beforeEach(async () => {
    backend = new ExecGitBackend();
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

  describe("blame", () => {
    it("says which commit each line came from, with its full message", async () => {
      await writeFile(path.join(tmpDir, "file.txt"), "hello\nworld\n");
      git(tmpDir, "add", ".");
      git(tmpDir, "commit", "-m", "add world", "-m", "because it was lonely");
      const result = await backend.blame(tmpDir, "file.txt");
      if (!result.ok) throw new Error(result.message);
      const at = (line: number) => result.commits[result.lines[line]];
      expect(result.lines).toHaveLength(2);
      expect(at(0)).toMatchObject({ author: "Test", summary: "initial", message: "initial" });
      expect(at(1)).toMatchObject({
        author: "Test",
        summary: "add world",
        message: "add world\n\nbecause it was lonely",
      });
      expect(at(1).sha).toBe(git(tmpDir, "rev-parse", "HEAD").trim());
      expect(at(1).time).toBeGreaterThan(1_000_000_000);
    });

    it("gives lines changed on disk the all-zero commit", async () => {
      await writeFile(path.join(tmpDir, "file.txt"), "hello\nnew\n");
      const result = await backend.blame(tmpDir, "file.txt");
      if (!result.ok) throw new Error(result.message);
      expect(result.commits[result.lines[0]].summary).toBe("initial");
      expect(result.commits[result.lines[1]].sha).toMatch(/^0+$/);
    });

    it("answers with git's reason when it can't blame", async () => {
      await expect(backend.blame(tmpDir, "nope.txt")).resolves.toMatchObject({
        ok: false,
        reason: "failed",
      });
    });

    it("tells a timeout from a failure and passes a limit to git", async () => {
      const file = vi.fn(() =>
        Promise.reject(
          Object.assign(new Error("killed"), { stdout: "", stderr: "", code: null }),
        ),
      );
      const timed = new ExecGitBackend({ ...localExec, file });
      await expect(timed.blame("/w", "a.ts")).resolves.toMatchObject({
        ok: false,
        reason: "timeout",
      });
      expect(file).toHaveBeenCalledTimes(1);
      expect(file).toHaveBeenCalledWith(
        "git",
        ["blame", "--porcelain", "--", "a.ts"],
        expect.objectContaining({ cwd: "/w", timeout: expect.any(Number) }),
      );
    });

    it("keeps the summary when messages can't be read", async () => {
      const real = localExec.file.bind(localExec);
      const failLog = new ExecGitBackend({
        ...localExec,
        file: (cmd, args, opts) =>
          args[0] === "log" ? Promise.reject(new Error("no")) : real(cmd, args, opts),
      });
      const result = await failLog.blame(tmpDir, "file.txt");
      if (!result.ok) throw new Error(result.message);
      expect(result.commits[0].message).toBe("initial");
    });

    describe("blameRevision", () => {
      it("is HEAD for a committed file, also one changed on disk", async () => {
        const head = git(tmpDir, "rev-parse", "HEAD").trim();
        await writeFile(path.join(tmpDir, "file.txt"), "changed\n");
        await expect(backend.blameRevision(tmpDir, "file.txt")).resolves.toBe(head);
      });

      it("is null for an untracked file, and one added but not committed", async () => {
        await writeFile(path.join(tmpDir, "new.txt"), "x\n");
        await expect(backend.blameRevision(tmpDir, "new.txt")).resolves.toBeNull();
        git(tmpDir, "add", "new.txt");
        await expect(backend.blameRevision(tmpDir, "new.txt")).resolves.toBeNull();
      });

      it("is null outside a repo", async () => {
        const outside = await mkdtemp(path.join(os.tmpdir(), "manor-no-repo-"));
        await writeFile(path.join(outside, "a.txt"), "x\n");
        await expect(backend.blameRevision(outside, "a.txt")).resolves.toBeNull();
        await rm(outside, { recursive: true, force: true });
      });
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

  describe("getFullDiff", () => {
    it("reuses the merge-base while HEAD and the ref are unchanged", async () => {
      const file = vi.fn(localExec.file);
      const spied = new ExecGitBackend({ ...localExec, file });
      const mergeBases = () =>
        file.mock.calls.filter(([, args]) => args[0] === "merge-base").length;

      await writeFile(path.join(tmpDir, "file.txt"), "one\n");
      expect(await spied.getFullDiff(tmpDir, "main")).toContain("+one");
      await writeFile(path.join(tmpDir, "file.txt"), "two\n");
      expect(await spied.getFullDiff(tmpDir, "main")).toContain("+two");
      expect(mergeBases()).toBe(1);

      git(tmpDir, "commit", "-am", "second");
      await spied.getFullDiff(tmpDir, "main");
      expect(mergeBases()).toBe(2);
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

    it("leaves binary and oversized untracked files out, unread", async () => {
      const readFile = vi.fn(localExec.readFile);
      const spied = new ExecGitBackend({ ...localExec, readFile });
      await writeFile(path.join(tmpDir, "notes.txt"), "text\n");
      await writeFile(path.join(tmpDir, "empty.txt"), "");
      await writeFile(path.join(tmpDir, "-dash.txt"), "dash\n");
      await writeFile(path.join(tmpDir, "glob*.txt"), "glob\n");
      await mkdir(path.join(tmpDir, "sub"));
      await writeFile(path.join(tmpDir, "sub", "nested.txt"), "nested\n");
      await writeFile(path.join(tmpDir, "image.png"), Buffer.from([0x89, 0x50, 0, 0, 1, 2]));
      await writeFile(path.join(tmpDir, "huge.txt"), "x".repeat(MAX_UNTRACKED_DIFF_BYTES));

      const diff = await spied.getLocalDiff(tmpDir);

      const read = readFile.mock.calls.map(([p]) => path.relative(tmpDir, p)).sort();
      expect(read).toEqual(
        ["-dash.txt", "empty.txt", "glob*.txt", "notes.txt", path.join("sub", "nested.txt")].sort(),
      );
      expect(diff).toContain("+text");
      expect(diff).toContain("+nested");
      expect(diff).toContain("b/empty.txt");
      expect(diff).not.toContain("image.png");
      expect(diff).not.toContain("huge.txt");
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

  describe("currentBranch", () => {
    it("returns the checked-out branch name", async () => {
      expect(await backend.currentBranch(tmpDir)).toBe("main");
    });

    it("falls back to a 7-char short SHA on detached HEAD, matching the local fs read", async () => {
      const sha = git(tmpDir, "rev-parse", "HEAD").trim();
      git(tmpDir, "checkout", sha);

      const branch = await backend.currentBranch(tmpDir);
      expect(branch).toBe(sha.slice(0, 7));
      expect(branch).toHaveLength(7);
    });

    it("returns null for a non-repo path", async () => {
      const nonRepo = await mkdtemp(path.join(os.tmpdir(), "manor-non-repo-"));
      try {
        expect(await backend.currentBranch(nonRepo)).toBeNull();
      } finally {
        await rm(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe("cloneStream", () => {
    it("clones a real repo end to end", async () => {
      const targetDir = path.join(await mkdtemp(path.join(os.tmpdir(), "manor-clone-")), "repo");
      await new Promise<void>((resolve, reject) => {
        backend.cloneStream(tmpDir, targetDir, {
          onLine: () => {},
          onDone: ({ exitCode, stderr }) => {
            if (exitCode === 0) resolve();
            else reject(new Error(stderr));
          },
        });
      });
      try {
        const clonedLog = await new ExecGitBackend().exec(targetDir, ["log", "--oneline"]);
        expect(clonedLog).toContain("initial");
      } finally {
        await rm(targetDir, { recursive: true, force: true });
      }
    });

    it(
      "puts `--` before the repo URL and target dir, so a value starting " +
        "with `-` cannot be misread as a git option",
      async () => {
        const calls: Array<{ args: string[] }> = [];
        const fakeExecImpl = {
          stream: (_cmd: string, args: string[], _opts: unknown, cb: { onExit: (r: { exitCode: number | null }) => void }) => {
            calls.push({ args });
            cb.onExit({ exitCode: 0 });
            return { cancel: () => {} };
          },
        };
        const fakeBackend = new ExecGitBackend(fakeExecImpl as never);
        await new Promise<void>((resolve) => {
          fakeBackend.cloneStream("-oProxyCommand=whoami", "/tmp/target", {
            onLine: () => {},
            onDone: () => resolve(),
          });
        });
        expect(calls).toHaveLength(1);
        const args = calls[0].args;
        const dashDashIndex = args.indexOf("--");
        expect(dashDashIndex).toBeGreaterThan(-1);
        expect(args.slice(dashDashIndex + 1)).toEqual([
          "-oProxyCommand=whoami",
          "/tmp/target",
        ]);
      },
    );
  });
});
