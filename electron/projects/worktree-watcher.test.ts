import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostUnavailableError } from "../backend/host-view";
import type { WorkspaceBackend } from "../backend/types";
import { gitCommonDir, RemoteWorktreePoller, WorktreeWatcher } from "./worktree-watcher";

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

describe("remote worktree poller", () => {
  let poller: RemoteWorktreePoller | null = null;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    poller?.dispose();
    poller = null;
    vi.useRealTimers();
  });

  /** A host whose `git worktree list` answers from `lists`, or throws `fail`. */
  function fakeHost(lists: Record<string, string[]>, fail: { err: Error | null }) {
    const worktreeList = vi.fn(async (cwd: string) => {
      if (fail.err) throw fail.err;
      if (!(cwd in lists)) throw new Error(`not a git repository: ${cwd}`);
      return (lists[cwd] ?? []).map((p, i) => ({ path: p, branch: "b", isMain: i === 0 }));
    });
    const backend = { git: { worktreeList } } as unknown as WorkspaceBackend;
    return { get: () => backend };
  }

  it("fires when a remote project's worktrees change, not on the first read", async () => {
    const lists = { "/r/proj": ["/r/proj"] };
    const fail = { err: null as Error | null };
    const onChange = vi.fn();
    poller = new RemoteWorktreePoller(fakeHost(lists, fail), onChange);
    poller.sync([{ path: "/r/proj", hostId: "box" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();

    lists["/r/proj"] = ["/r/proj", "/r/wt-1"];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the last lists while the host is unavailable", async () => {
    const lists = { "/r/proj": ["/r/proj", "/r/wt-1"] };
    const fail = { err: null as Error | null };
    const onChange = vi.fn();
    poller = new RemoteWorktreePoller(fakeHost(lists, fail), onChange);
    poller.sync([{ path: "/r/proj", hostId: "box" }]);
    await vi.advanceTimersByTimeAsync(10_000);

    fail.err = new HostUnavailableError("box", "reconnecting");
    await vi.advanceTimersByTimeAsync(20_000);
    fail.err = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes a newly added project's first read as its baseline", async () => {
    const lists: Record<string, string[]> = { "/r/a": ["/r/a"], "/r/b": ["/r/b", "/r/b-wt"] };
    const fail = { err: null as Error | null };
    const onChange = vi.fn();
    poller = new RemoteWorktreePoller(fakeHost(lists, fail), onChange);
    poller.sync([{ path: "/r/a", hostId: "box" }]);
    await vi.advanceTimersByTimeAsync(10_000);

    poller.sync([
      { path: "/r/a", hostId: "box" },
      { path: "/r/b", hostId: "box" },
    ]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not flicker when one project's read fails and recovers", async () => {
    const lists: Record<string, string[]> = { "/r/a": ["/r/a", "/r/a-wt"] };
    const fail = { err: null as Error | null };
    const onChange = vi.fn();
    poller = new RemoteWorktreePoller(fakeHost(lists, fail), onChange);
    poller.sync([{ path: "/r/a", hostId: "box" }]);
    await vi.advanceTimersByTimeAsync(10_000);

    fail.err = new Error("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    fail.err = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("forgets a project dropped from sync, so re-adding it starts a new baseline", async () => {
    const lists: Record<string, string[]> = { "/r/a": ["/r/a"] };
    const fail = { err: null as Error | null };
    const onChange = vi.fn();
    poller = new RemoteWorktreePoller(fakeHost(lists, fail), onChange);
    poller.sync([{ path: "/r/a", hostId: "box" }]);
    await vi.advanceTimersByTimeAsync(10_000);

    poller.sync([]);
    lists["/r/a"] = ["/r/a", "/r/a-wt"];
    poller.sync([{ path: "/r/a", hostId: "box" }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
