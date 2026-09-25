import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Exec } from "../exec";

// ── Mock node:child_process ──
//
// Branch resolution in `pushStream` uses `execFileSync` directly (it must
// return its cancel handle synchronously), so that still goes through
// node:child_process. The push itself now goes through an injected `Exec`,
// which we fake below so we can drive its callbacks directly.

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  // exec.ts imports these at module scope (for `localExec`); local-git.ts
  // imports `localExec` as a value even though this test injects a fake
  // `Exec`, so these must exist to avoid failing at import time.
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { LocalGitBackend } from "../local-git";

type StreamCb = {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExit: (result: { exitCode: number | null; error?: string }) => void;
};

function makeFakeExec() {
  const cancel = vi.fn();
  const streamMock = vi.fn();
  let capturedCb: StreamCb | null = null;

  streamMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: { cwd?: string; env?: Record<string, string> },
      cb: StreamCb,
    ) => {
      capturedCb = cb;
      return { cancel };
    },
  );

  const exec: Exec = {
    file: vi.fn(),
    stream: streamMock,
    readFile: vi.fn(),
  };

  return {
    exec,
    streamMock,
    cancel,
    emitStderr: (chunk: string) => capturedCb?.onStderr?.(chunk),
    emitExit: (exitCode: number | null) => capturedCb?.onExit({ exitCode }),
    emitError: (error: string) =>
      capturedCb?.onExit({ exitCode: null, error }),
  };
}

describe("LocalGitBackend.pushStream", () => {
  let backend: LocalGitBackend;
  let fake: ReturnType<typeof makeFakeExec>;

  beforeEach(() => {
    fake = makeFakeExec();
    backend = new LocalGitBackend(fake.exec);
    execFileSyncMock.mockReset();
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
      expect(fake.streamMock).toHaveBeenCalledOnce();
      const [cmd, args] = fake.streamMock.mock.calls[0];
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
      const [, args] = fake.streamMock.mock.calls[0];
      expect(args).toEqual(["push", "upstream", "feature"]);
    });

    it("includes --set-upstream when opts.setUpstream is true", () => {
      backend.pushStream(
        "/repo",
        { branch: "feature", setUpstream: true },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      const [, args] = fake.streamMock.mock.calls[0];
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

      const opts = fake.streamMock.mock.calls[0][2] as {
        cwd: string;
        env: Record<string, string>;
      };
      expect(opts.cwd).toBe("/repo");
      // Overrides only: the Exec merges them onto its own base env, so the
      // caller must not ship its whole process.env (wrong for a remote Exec).
      expect(opts.env).toEqual({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/true",
      });
    });
  });

  describe("line buffering", () => {
    it("emits complete lines and holds partial chunks", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();
      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitStderr("foo\nbar");
      // No newline after 'bar' yet — only 'foo' should be flushed.
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenNthCalledWith(1, "foo");

      fake.emitStderr("\nbaz\n");
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

      fake.emitStderr("partial");
      // No newline — pending should hold it.
      expect(onLine).not.toHaveBeenCalled();

      fake.emitExit(0);

      expect(calls).toEqual(["line:partial", "done"]);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 0, stderr: "partial" });
    });

    it("does not emit a final empty line when stderr ended cleanly", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();

      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitStderr("done\n");
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenCalledWith("done");

      fake.emitExit(0);
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
      fake.emitStderr("nope\n");
      fake.emitExit(1);
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
      expect(fake.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("spawn / runtime errors", () => {
    it("calls onDone with the error message when the exec stream errors", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();
      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitError("spawn git ENOENT");

      expect(onDone).toHaveBeenCalledWith({
        exitCode: null,
        stderr: "spawn git ENOENT",
      });
      // The spawn error is not push progress.
      expect(onLine).not.toHaveBeenCalled();
    });

    it("reports only the error, not partial stderr, when the stream errors", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();
      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitStderr("partial");
      fake.emitError("boom");

      expect(onLine).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledWith({ exitCode: null, stderr: "boom" });
    });

    it("does not double-fire onDone when exit fires twice", () => {
      const onDone = vi.fn();
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone },
      );

      fake.emitExit(null);
      fake.emitExit(null);

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
      // No stream should have been started.
      expect(fake.streamMock).not.toHaveBeenCalled();
      // Cancel must still be callable without error.
      expect(() => cancel()).not.toThrow();
    });
  });
});
