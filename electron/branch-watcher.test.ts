import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { BranchWatcher } from "./branch-watcher";
import { LOCAL_HOST_ID, type GitBackend } from "./backend/types";
import { HostUnavailableError } from "./backend/registry";
import type { HostForPath } from "./backend/routed-backend";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** A fake `BrowserWindow` capturing every `branches-changed` send. */
function fakeWindow(): { window: BrowserWindow; sends: Array<Record<string, string>> } {
  const sends: Array<Record<string, string>> = [];
  const window = {
    webContents: {
      send: (channel: string, payload: Record<string, string>) => {
        if (channel === "branches-changed") sends.push(payload);
      },
    },
  } as unknown as BrowserWindow;
  return { window, sends };
}

/** A minimal `GitBackend` stub — only `currentBranch` matters here. */
function fakeGit(impl: (repoPath: string) => Promise<string | null>): GitBackend {
  return {
    exec: vi.fn(async () => ""),
    stage: vi.fn(async () => {}),
    unstage: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    stash: vi.fn(async () => {}),
    pushStream: vi.fn(),
    getFullDiff: vi.fn(async () => null),
    getLocalDiff: vi.fn(async () => null),
    getStagedFiles: vi.fn(async () => []),
    worktreeList: vi.fn(async () => []),
    worktreeAdd: vi.fn(async () => {}),
    worktreeRemove: vi.fn(async () => {}),
    currentBranch: vi.fn(impl),
  } as unknown as GitBackend;
}

describe("BranchWatcher", () => {
  let tmpDir: string;
  let watcher: BranchWatcher;

  beforeEach(async () => {
    tmpDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "manor-branch-test-")));
    git(tmpDir, "init", "-b", "main");
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test");
    execFileSync("sh", ["-c", "echo hi > file.txt"], { cwd: tmpDir });
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "initial");
  });

  afterEach(async () => {
    watcher?.stop();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("emits the local branch, matching the old single-host watcher", async () => {
    const gitBackend = fakeGit(async () => "should-not-be-used");
    watcher = new BranchWatcher(gitBackend);
    const { window, sends } = fakeWindow();

    watcher.start(window, [tmpDir]);
    // The initial tick runs synchronously-ish; flush microtasks.
    await new Promise((r) => setTimeout(r, 10));

    expect(sends).toEqual([{ [tmpDir]: "main" }]);
  });

  it("emits {} once when started with no paths, clearing stale branches", async () => {
    const gitBackend = fakeGit(async () => null);
    watcher = new BranchWatcher(gitBackend);
    const { window, sends } = fakeWindow();

    // First populate lastBranches with something...
    watcher.start(window, [tmpDir]);
    await new Promise((r) => setTimeout(r, 10));
    expect(sends).toEqual([{ [tmpDir]: "main" }]);

    // ...then restart with zero paths: the renderer must see the clear.
    watcher.start(window, []);
    await new Promise((r) => setTimeout(r, 10));

    expect(sends).toEqual([{ [tmpDir]: "main" }, {}]);
  });

  it("does not re-emit on restart with identical data", async () => {
    const gitBackend = fakeGit(async () => null);
    watcher = new BranchWatcher(gitBackend);
    const { window, sends } = fakeWindow();

    watcher.start(window, [tmpDir]);
    await new Promise((r) => setTimeout(r, 10));
    expect(sends).toEqual([{ [tmpDir]: "main" }]);

    watcher.start(window, [tmpDir]);
    await new Promise((r) => setTimeout(r, 10));

    // Same workspace, same branch — no second emit.
    expect(sends).toEqual([{ [tmpDir]: "main" }]);
  });

  it("polls a remote host through git.currentBranch on its own 5s cadence", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const gitBackend = fakeGit(async (p) => {
      calls.push(p);
      return "remote-branch";
    });
    const hostForPath: HostForPath = (p) => (p === "/remote/ws" ? "box" : LOCAL_HOST_ID);
    watcher = new BranchWatcher(gitBackend, hostForPath);
    const { window, sends } = fakeWindow();

    watcher.start(window, ["/remote/ws"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual([{ "/remote/ws": "remote-branch" }]);
    expect(calls).toEqual(["/remote/ws"]);

    // Nothing new before the 5s remote cadence elapses.
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toEqual(["/remote/ws"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(["/remote/ws", "/remote/ws"]);
  });

  it("skips a tick for a host whose previous scan is still in flight", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const gitBackend = fakeGit(async (p) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20000));
      inFlight--;
      return p;
    });
    const hostForPath: HostForPath = () => "box";
    watcher = new BranchWatcher(gitBackend, hostForPath);
    const { window } = fakeWindow();

    watcher.start(window, ["/remote/ws"]);
    await vi.advanceTimersByTimeAsync(0);
    // Let two more 5s ticks fire while the first scan (20s) is still pending.
    await vi.advanceTimersByTimeAsync(10000);

    expect(maxInFlight).toBe(1);
  });

  it("keeps the last-known branches and does not log when a host is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = false;
    const gitBackend = fakeGit(async () => {
      if (fail) throw new HostUnavailableError("box", "disconnected");
      return "remote-branch";
    });
    const hostForPath: HostForPath = () => "box";
    watcher = new BranchWatcher(gitBackend, hostForPath);
    const { window, sends } = fakeWindow();

    watcher.start(window, ["/remote/ws"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(sends).toEqual([{ "/remote/ws": "remote-branch" }]);

    fail = true;
    // Manually trigger another scan by restarting (simulating the next
    // tick failing with HostUnavailableError).
    watcher.stop();
    watcher.start(window, ["/remote/ws"]);
    await new Promise((r) => setTimeout(r, 10));

    // No new emit (the failed scan contributes no update) and no error log.
    expect(sends).toEqual([{ "/remote/ws": "remote-branch" }]);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
