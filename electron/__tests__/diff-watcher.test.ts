/**
 * DiffWatcher's cost per tick (issue #302): the merge-base is reused while
 * HEAD and the ref stay put, a host's workspaces are diffed a few at a time,
 * the shortstat runs only when a workspace's fingerprint moves, and that
 * fingerprint — what an open diff pane re-fetches on — is sent only when it
 * changes, including for edits the shortstat cannot see.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { BrowserWindow } from "electron";
import { DIFF_CONCURRENCY, DiffWatcher, pathsToHash } from "../diff-watcher";
import type { GitBackend } from "../backend/types";
import type { HostBackends } from "../per-host-poller";

interface RepoState {
  head: string;
  refSha: string;
  shortstat: string;
  /** `git status --porcelain=v2 -z` records, joined with NUL by the fake. */
  status: string[];
  /** Working-tree content by path, hashed by the fake `hash-object`. */
  files: Record<string, string>;
}

const repo = (over: Partial<RepoState> = {}): RepoState => ({
  head: "h1",
  refSha: "r1",
  shortstat: "",
  status: [],
  files: {},
  ...over,
});

/** The git subcommand of `args`, past any global options. */
const subcommand = (args: string[]) => args.find((a) => !a.startsWith("--")) ?? "";

/** A git whose every workspace answers from `state`. */
function fakeGit(state: RepoState) {
  const exec = vi.fn(async (_cwd: string, args: string[]) => {
    switch (subcommand(args)) {
      case "rev-parse":
        return `${state.head}\n${state.refSha}\n`;
      case "merge-base":
        return `base-of-${state.head}\n`;
      case "status":
        return state.status.map((r) => `${r}\0`).join("");
      case "hash-object": {
        const paths = args.slice(args.indexOf("--") + 1);
        return paths.map((p) => `hash(${state.files[p] ?? ""})\n`).join("");
      }
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
  exec.mock.calls.filter(([, args]) => subcommand(args as string[]) === cmd);

/** An unstaged modification of a tracked file. */
const modified = (path: string, indexHash = "i1") =>
  `1 .M N... 100644 100644 100644 h0 ${indexHash} ${path}`;

/** Start watching `/app` over `state` and run the first tick. */
async function watch(state: RepoState) {
  const { git, exec } = fakeGit(state);
  const watcher = new DiffWatcher(hostsWith(git));
  const { window, send } = fakeWindow();
  watcher.start(window, [diffWs("/app")]);
  await vi.advanceTimersByTimeAsync(0);
  return { watcher, exec, send };
}

/** How many fingerprints `send` has sent for `/app` so far. */
const fingerprintsSent = (send: ReturnType<typeof vi.fn>) =>
  sentOn(send, "diff-fingerprints-changed").length;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DiffWatcher", () => {
  it("reuses the merge-base while HEAD and the ref are unchanged", async () => {
    const state = repo({ shortstat: " 1 file changed, 2 insertions(+)" });
    const { watcher, exec } = await watch(state);

    // Each tick sees a new edit, so the shortstat runs every time.
    state.status = [modified("a.ts")];
    state.files["a.ts"] = "one";
    await vi.advanceTimersByTimeAsync(5000);
    state.files["a.ts"] = "two";
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

  it("skips the shortstat, and sends nothing, while nothing has changed", async () => {
    const state = repo({
      shortstat: " 1 file changed, 1 insertion(+)",
      status: [modified("a.ts")],
      files: { "a.ts": "x" },
    });
    const { watcher, exec, send } = await watch(state);
    expect(sentOn(send, "diffs-changed")).toEqual([{ "/app": { added: 1, removed: 0 } }]);
    expect(fingerprintsSent(send)).toBe(1);

    await vi.advanceTimersByTimeAsync(15000);
    expect(callsOf(exec, "status")).toHaveLength(4);
    expect(callsOf(exec, "diff")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("polls status without taking git's optional locks", async () => {
    const { watcher, exec } = await watch(repo());
    expect(callsOf(exec, "status")[0]?.[1]).toEqual([
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]);
    watcher.stop();
  });

  it(`runs at most ${DIFF_CONCURRENCY} workspaces' git at once`, async () => {
    let running = 0;
    let peak = 0;
    const exec = vi.fn(async (_cwd: string, args: string[]) => {
      const cmd = subcommand(args);
      if (cmd === "rev-parse") return "h\nr\n";
      if (cmd === "merge-base") return "base\n";
      if (cmd === "status") return "";
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

  it("gives a clean workspace a fingerprint, and moves it on a commit", async () => {
    const state = repo();
    const { watcher, send } = await watch(state);
    // A clean workspace has no stats, but still has a fingerprint.
    expect(sentOn(send, "diffs-changed")).toEqual([{}]);
    const first = last(sentOn(send, "diff-fingerprints-changed")) as Record<string, string>;
    expect(first["/app"]).toMatch(/^[0-9a-f]{40}$/);

    // A commit that leaves the shortstat as it was still moves HEAD.
    send.mockClear();
    state.head = "h2";
    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprintsSent(send)).toBe(1);
    expect(sentOn(send, "diffs-changed")).toHaveLength(0);
    watcher.stop();
  });

  it("moves the fingerprint on an edit that keeps the line counts", async () => {
    const state = repo({
      shortstat: " 1 file changed, 1 insertion(+), 1 deletion(-)",
      status: [modified("src/a b.ts")],
      files: { "src/a b.ts": "const x = 1;" },
    });
    const { watcher, send } = await watch(state);

    send.mockClear();
    state.files["src/a b.ts"] = "const x = 2;";
    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprintsSent(send)).toBe(1);
    // The stats did not change, so they are not re-sent.
    expect(sentOn(send, "diffs-changed")).toHaveLength(0);
    watcher.stop();
  });

  it("moves the fingerprint when an untracked file is created or edited", async () => {
    const state = repo();
    const { watcher, send } = await watch(state);

    state.status = ["? notes.md"];
    state.files["notes.md"] = "draft";
    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprintsSent(send)).toBe(2);

    state.files["notes.md"] = "final";
    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprintsSent(send)).toBe(3);

    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprintsSent(send)).toBe(3);
    watcher.stop();
  });

  it("moves the fingerprint when a file is staged or unstaged from a terminal", async () => {
    const state = repo({
      shortstat: " 1 file changed, 1 insertion(+)",
      status: [modified("a.ts")],
      files: { "a.ts": "x" },
    });
    const { watcher, send } = await watch(state);

    // `git add a.ts`: same content, same shortstat, now in the index.
    state.status = ["1 M. N... 100644 100644 100644 h0 i2 a.ts"];
    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprintsSent(send)).toBe(2);

    // `git restore --staged a.ts`
    state.status = [modified("a.ts")];
    await vi.advanceTimersByTimeAsync(5000);
    expect(fingerprintsSent(send)).toBe(3);
    watcher.stop();
  });

  it("still sends a fingerprint when a file cannot be hashed", async () => {
    const state = repo({ status: ["? gone.txt"] });
    const { git, exec } = fakeGit(state);
    exec.mockImplementation(async (_cwd: string, args: string[]) => {
      const cmd = subcommand(args);
      if (cmd === "rev-parse") return "h1\nr1\n";
      if (cmd === "status") return "? gone.txt\0";
      if (cmd === "hash-object") throw new Error("fatal: could not open 'gone.txt'");
      return "";
    });
    const watcher = new DiffWatcher(hostsWith(git));
    const { window, send } = fakeWindow();
    watcher.start(window, [diffWs("/app")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fingerprintsSent(send)).toBe(1);
    watcher.stop();
  });

  it("does not log what it emits", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const state = repo({ shortstat: " 1 file changed, 1 insertion(+)" });
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

describe("pathsToHash", () => {
  it("names the files whose working-tree content git has not recorded", () => {
    const status = [
      "1 .M N... 100644 100644 100644 a a changed.ts",
      "1 M. N... 100644 100644 100644 a b staged-only.ts",
      "1 MM N... 100644 100644 100644 a b both.ts",
      "1 .D N... 100644 100644 000000 a a deleted.ts",
      "1 .M S.M. 160000 160000 160000 a a vendor/sub",
      "2 RM N... 100644 100644 100644 a a R100 new name.ts",
      "old name.ts",
      "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
      "u DU N... 100644 100644 100644 100644 a b c gone.ts",
      "? untracked.md",
      "? nested-repo/",
      "",
    ].join("\0");
    expect(pathsToHash(status)).toEqual([
      "changed.ts",
      "both.ts",
      "new name.ts",
      "conflict.ts",
      "untracked.md",
    ]);
  });
});
