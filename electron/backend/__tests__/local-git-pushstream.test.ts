import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ── Mock node:child_process ──
//
// We need to control both `spawn` (for the actual push) and `execFileSync`
// (for the synchronous branch resolution). The mock factory exposes them
// so each test can program their behaviour individually.

type FakeChild = EventEmitter & {
  stderr: PassThrough;
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  // Keep execFile present for ./exec.ts (uses promisified execFile). Tests that
  // need it can override; these tests don't exercise async execGit paths.
  execFile: vi.fn(),
}));

import { LocalGitBackend } from "../local-git";

describe("LocalGitBackend.pushStream", () => {
  let backend: LocalGitBackend;
  let child: FakeChild;

  beforeEach(() => {
    backend = new LocalGitBackend();
    child = makeFakeChild();
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    spawnMock.mockReturnValue(child);
    // Default: branch resolution returns "main".
    execFileSyncMock.mockReturnValue("main\n");
  });

  describe("argument composition", () => {
    it("uses default remote 'origin' and resolved branch", () => {
      backend.pushStream("/repo", {}, { onLine: vi.fn(), onDone: vi.fn() });

      expect(execFileSyncMock).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        expect.objectContaining({ cwd: "/repo", encoding: "utf-8" }),
      );
      expect(spawnMock).toHaveBeenCalledOnce();
      const [cmd, args] = spawnMock.mock.calls[0];
      expect(cmd).toBe("git");
      expect(args).toEqual(["push", "origin", "main"]);
    });

    it("uses explicit branch and remote without resolving", () => {
      backend.pushStream(
        "/repo",
        { remote: "upstream", branch: "feature" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      expect(execFileSyncMock).not.toHaveBeenCalled();
      const [, args] = spawnMock.mock.calls[0];
      expect(args).toEqual(["push", "upstream", "feature"]);
    });

    it("includes --set-upstream when opts.setUpstream is true", () => {
      backend.pushStream(
        "/repo",
        { branch: "feature", setUpstream: true },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      const [, args] = spawnMock.mock.calls[0];
      expect(args).toEqual(["push", "--set-upstream", "origin", "feature"]);
    });
  });

  describe("environment", () => {
    it("sets GIT_TERMINAL_PROMPT=0 and GIT_ASKPASS=/bin/true", () => {
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      const opts = spawnMock.mock.calls[0][2] as {
        cwd: string;
        env: Record<string, string>;
      };
      expect(opts.cwd).toBe("/repo");
      expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(opts.env.GIT_ASKPASS).toBe("/bin/true");
    });
  });

  describe("line buffering", () => {
    it("emits complete lines and holds partial chunks", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();
      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      child.stderr.write("foo\nbar");
      // No newline after 'bar' yet — only 'foo' should be flushed.
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenNthCalledWith(1, "foo");

      child.stderr.write("\nbaz\n");
      // Now we expect 'bar' and 'baz' to flush.
      expect(onLine).toHaveBeenCalledTimes(3);
      expect(onLine).toHaveBeenNthCalledWith(2, "bar");
      expect(onLine).toHaveBeenNthCalledWith(3, "baz");

      // onDone should not yet have fired.
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  describe("drain on close", () => {
    it("emits trailing partial line before onDone", () => {
      const calls: string[] = [];
      const onLine = vi.fn((line: string) => calls.push(`line:${line}`));
      const onDone = vi.fn(() => calls.push("done"));

      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      child.stderr.write("partial");
      // No newline — pending should hold it.
      expect(onLine).not.toHaveBeenCalled();

      child.emit("close", 0);

      expect(calls).toEqual(["line:partial", "done"]);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 0, stderr: "partial" });
    });

    it("does not emit a final empty line when stderr ended cleanly", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();

      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      child.stderr.write("done\n");
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenCalledWith("done");

      child.emit("close", 0);
      // Pending was empty, so no extra line should fire.
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 0, stderr: "done\n" });
    });

    it("forwards non-zero exit codes", () => {
      const onDone = vi.fn();
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone },
      );
      child.stderr.write("nope\n");
      child.emit("close", 1);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 1, stderr: "nope\n" });
    });
  });

  describe("cancel", () => {
    it("returns a function that sends SIGTERM", () => {
      const { cancel } = backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      cancel();
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("is a no-op when called after close", () => {
      const { cancel } = backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      child.emit("close", 0);
      cancel();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("only calls kill once across multiple cancel invocations after exit", () => {
      const { cancel } = backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      cancel();
      child.emit("close", null);
      cancel();
      cancel();

      expect(child.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe("spawn / runtime errors", () => {
    it("calls onDone with the error message when child emits 'error'", () => {
      const onDone = vi.fn();
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone },
      );

      child.emit("error", new Error("ENOENT: git not found"));

      expect(onDone).toHaveBeenCalledWith({
        exitCode: null,
        stderr: "ENOENT: git not found",
      });
    });

    it("does not double-fire onDone when error precedes close", () => {
      const onDone = vi.fn();
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone },
      );

      child.emit("error", new Error("boom"));
      child.emit("close", null);

      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe("branch resolution failure", () => {
    it("invokes onDone with the error and returns a no-op cancel", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("not a git repository");
      });

      const onDone = vi.fn();
      const { cancel } = backend.pushStream(
        "/notrepo",
        {},
        { onLine: vi.fn(), onDone },
      );

      expect(onDone).toHaveBeenCalledWith({
        exitCode: null,
        stderr: "not a git repository",
      });
      // No spawn should have happened.
      expect(spawnMock).not.toHaveBeenCalled();
      // Cancel must still be callable without error.
      expect(() => cancel()).not.toThrow();
    });
  });
});
