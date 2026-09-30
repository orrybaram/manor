/**
 * DiffWatcher's cost per tick (issue #302): the merge-base is reused while
 * HEAD and the ref stay put, a host's workspaces are diffed a few at a time,
 * and each workspace's fingerprint — what an open diff pane re-fetches on —
 * is sent only when it changes.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { BrowserWindow } from "electron";
import { DIFF_CONCURRENCY, DiffWatcher } from "../diff-watcher";
import type { GitBackend } from "../backend/types";
import type { HostBackends } from "../per-host-poller";

interface RepoState {
  head: string;
  refSha: string;
  shortstat: string;
}

/** A git whose every workspace answers from `state`. */
function fakeGit(state: RepoState) {
  const exec = vi.fn(async (_cwd: string, args: string[]) => {
    switch (args[0]) {
      case "rev-parse":
        return `${state.head}\n${state.refSha}\n`;
      case "merge-base":
        return `base-of-${state.head}\n`;
      default:
        return state.shortstat;
    }
  });
  return { git: { exec } as unknown as GitBackend, exec };
}

const hostsWith = (git: GitBackend) => ({ get: () => ({ git }) }) as unknown as HostBackends;

const diffWs = (path: string) => ({ path, hostId: "local", defaultBranch: "main" });

function fakeWindow() {
  const send = vi.fn();
  return { window: { webContents: { send } } as unknown as BrowserWindow, send };
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

const sentOn = (send: ReturnType<typeof vi.fn>, channel: string) =>
  send.mock.calls.filter(([c]) => c === channel).map(([, payload]) => payload as unknown);

const callsOf = (exec: ReturnType<typeof vi.fn>, cmd: string) =>
  exec.mock.calls.filter(([, args]) => (args as string[])[0] === cmd);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DiffWatcher", () => {
  it("reuses the merge-base while HEAD and the ref are unchanged", async () => {
    const state = { head: "h1", refSha: "r1", shortstat: " 1 file changed, 2 insertions(+)" };
    const { git, exec } = fakeGit(state);
    const watcher = new DiffWatcher(hostsWith(git));
    watcher.start(fakeWindow().window, [diffWs("/app")]);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsOf(exec, "rev-parse")).toHaveLength(3);
    expect(callsOf(exec, "merge-base")).toHaveLength(1);
    // Every diff ran against the cached merge-base.
    expect(callsOf(exec, "diff").map(([, args]) => (args as string[])[1])).toEqual([
      "base-of-h1",
      "base-of-h1",
      "base-of-h1",
    ]);

    state.head = "h2";
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsOf(exec, "merge-base")).toHaveLength(2);

    state.refSha = "r2";
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsOf(exec, "merge-base")).toHaveLength(3);
    expect(last(callsOf(exec, "diff"))?.[1]).toEqual(["diff", "base-of-h2", "--shortstat"]);
    watcher.stop();
  });

  it(`runs at most ${DIFF_CONCURRENCY} workspaces' git at once`, async () => {
    let running = 0;
    let peak = 0;
    const exec = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") return "h\nr\n";
      if (args[0] === "merge-base") return "base\n";
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running--;
      return " 1 file changed, 1 insertion(+)";
    });
    const watcher = new DiffWatcher(hostsWith({ exec } as unknown as GitBackend));
    const { window, send } = fakeWindow();
    const workspaces = Array.from({ length: 10 }, (_, i) => diffWs(`/ws${i}`));

    watcher.start(window, workspaces);
    await vi.advanceTimersByTimeAsync(1000);

    expect(callsOf(exec, "diff")).toHaveLength(10);
    expect(peak).toBe(DIFF_CONCURRENCY);
    // Every workspace still got its stats.
    expect(Object.keys(last(sentOn(send, "diffs-changed")) as object)).toHaveLength(10);
    watcher.stop();
  });

  it("sends each workspace's fingerprint only when it changes", async () => {
    const state = { head: "h1", refSha: "r1", shortstat: "" };
    const { git } = fakeGit(state);
    const watcher = new DiffWatcher(hostsWith(git));
    const { window, send } = fakeWindow();
    watcher.start(window, [diffWs("/app")]);

    await vi.advanceTimersByTimeAsync(0);
    // A clean workspace has no stats, but still has a fingerprint.
    expect(sentOn(send, "diffs-changed")).toEqual([{}]);
    expect(sentOn(send, "diff-fingerprints-changed")).toEqual([{ "/app": "h1:r1:" }]);

    // Nothing moved: nothing is sent, so an open diff pane does nothing.
    await vi.advanceTimersByTimeAsync(15000);
    expect(send).toHaveBeenCalledTimes(2);

    state.shortstat = " 1 file changed, 1 insertion(+)";
    await vi.advanceTimersByTimeAsync(5000);
    expect(last(sentOn(send, "diff-fingerprints-changed"))).toEqual({
      "/app": "h1:r1:1 file changed, 1 insertion(+)",
    });

    // A commit that leaves the shortstat as it was still moves HEAD.
    send.mockClear();
    state.head = "h2";
    await vi.advanceTimersByTimeAsync(5000);
    expect(sentOn(send, "diff-fingerprints-changed")).toHaveLength(1);
    expect(sentOn(send, "diffs-changed")).toHaveLength(0);
    watcher.stop();
  });

  it("does not log what it emits", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const state = { head: "h1", refSha: "r1", shortstat: " 1 file changed, 1 insertion(+)" };
    const { git } = fakeGit(state);
    const watcher = new DiffWatcher(hostsWith(git));
    const { window, send } = fakeWindow();
    watcher.start(window, [diffWs("/app")]);
    log.mockClear();

    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    watcher.stop();
  });
});
