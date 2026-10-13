import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitCommonDir, WorktreeWatcher } from "./worktree-watcher";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "ignore" });

/** Resolves once `fn` returns true, polling; rejects after `timeoutMs`. */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("worktree watcher", () => {
  let tmp: string;
  let repo: string;
  let watcher: WorktreeWatcher | null = null;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-watch-")));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  });

  afterEach(() => {
    watcher?.dispose();
    watcher = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves the common dir from a clone and from a linked worktree", () => {
    const linked = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    expect(gitCommonDir(repo)).toBe(path.join(repo, ".git"));
    expect(gitCommonDir(linked)).toBe(path.join(repo, ".git"));
    expect(gitCommonDir(tmp)).toBeNull();
  });

  it("fires when a worktree is added and removed outside Manor", async () => {
    const onChange = vi.fn();
    watcher = new WorktreeWatcher(onChange);
    watcher.sync([repo]);

    // The first worktree also creates `.git/worktrees/` itself.
    const first = path.join(tmp, "first");
    git(repo, "worktree", "add", "-q", "-b", "first", first);
    await waitFor(() => onChange.mock.calls.length >= 1);

    // A second lands inside the now-existing `worktrees/`.
    onChange.mockClear();
    const second = path.join(tmp, "second");
    git(repo, "worktree", "add", "-q", "-b", "second", second);
    await waitFor(() => onChange.mock.calls.length >= 1);

    onChange.mockClear();
    git(repo, "worktree", "remove", second);
    await waitFor(() => onChange.mock.calls.length >= 1);
  });

  it("stops watching repos dropped from sync", async () => {
    const onChange = vi.fn();
    watcher = new WorktreeWatcher(onChange);
    watcher.sync([repo]);
    watcher.sync([]);
    git(repo, "worktree", "add", "-q", "-b", "gone", path.join(tmp, "gone"));
    await new Promise((r) => setTimeout(r, 600));
    expect(onChange).not.toHaveBeenCalled();
  });
});
